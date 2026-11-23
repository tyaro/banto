/**
 * A `persistent` pane of `ThreePaneDock` keeps its scroll position through a re-arrangement
 * and a tab switch (#768): the offset of the pane's own frame (`.body`, re-created by `float` /
 * `dockBack` / `move({ tabWith })` / `resetLayout`, shared by the tabs of a group) and the
 * offset of an element inside the content that scrolls by itself.
 *
 * jsdom has no layout (every `scrollTop` is 0 and nothing is clamped), so this runs in a real
 * browser. Same harness as `dock-persistent-focus.spec.ts`: on /tree/workspace-dock the spec
 * imports the package's public entry and `svelte` through the dev server's `/@fs/` and mounts
 * its own `ThreePaneDock` with a `persistent` right pane over the page.
 */
import { expect, test, type Page } from '@playwright/test';
import { primeThemeAndAuth } from '../visual/theme';
import { dockUrls } from './dock-harness';

// Cold dev server: first compile / dep optimisation can reload the page.
test.setTimeout(120_000);
// Short, so the form overflows the pane wherever it is (the issue's reproduction).
test.use({ viewport: { width: 1280, height: 400 } });

type Operation = 'float' | 'dockBack' | 'tabWithLeft' | 'resetLayout';

interface ScrollReport {
	outcome: string;
	/** `scrollTop` of the `.body` around the right pane, after the operation. */
	frame: number;
	/** `scrollTop` of the scroller inside the content. */
	inner: number;
	/** The `.body` is another element than before (the receptacle was re-created). */
	frameRecreated: boolean;
	sameContent: boolean;
	activeIsInput: boolean;
}

/**
 * `tabbed`: start with the right and the left pane as the tabs of one group, the right one on
 * top - so the left pane was never on screen (nothing is recorded for it).
 */
async function mountHarness(
	page: Page,
	persistent: string[] = ['right'],
	tabbed = false
): Promise<void> {
	await primeThemeAndAuth(page, { theme: 'light', preset: 'standard' });
	await page.goto('/tree/workspace-dock');
	await expect(page.getByTestId('workspace-dock-center')).toBeVisible({ timeout: 60_000 });
	// The dev server may reload the page once more while it optimises deps: mount until it holds.
	await expect(async () => {
		const urls = await dockUrls(page);
		await page.evaluate(
			async ({ urls, persistent, tabbed }) => {
				const w = window as unknown as Record<string, unknown>;
				if (w.__dock768) return;
				const dockMod = await import(/* @vite-ignore */ urls.dock);
				const svelte = await import(/* @vite-ignore */ urls.svelte);
				const rows = (name: string, count: number) =>
					Array.from(
						{ length: count },
						(_, i) =>
							`<label style="display:block;height:32px">${name} ${i} <input aria-label="${name} field ${i}" /></label>`
					).join('');
				// A long form (the pane's frame scrolls) with a list on top that scrolls by itself.
				const pane = (name: string) =>
					svelte.createRawSnippet(() => ({
						render: () =>
							`<div data-pane="${name}">` +
							`<div data-inner="${name}" style="height:96px;overflow:auto">` +
							`<div style="height:1200px">${name} list</div></div>` +
							rows(name, 60) +
							`</div>`
					}));
				const target = document.createElement('div');
				target.id = 'dock768';
				target.style.cssText = 'position:fixed;inset:0;z-index:2147483000;background:#fff';
				document.body.append(target);
				const panel = (id: string) => ({ type: 'panel', id, title: id });
				const state = dockMod.createDockState(
					tabbed
						? {
								version: 4,
								floating: [],
								docked: {
									type: 'split',
									id: 'tabbed-root',
									direction: 'row',
									sizes: [0.4, 0.6],
									children: [
										{
											type: 'tabs',
											id: 'tabbed-group',
											activeIndex: 0,
											children: [panel('right'), panel('left')]
										},
										panel('center')
									]
								}
							}
						: undefined
				);
				// For a test that applies two updates in one task (no microtask in between).
				w.__dock768state = state;
				w.__dock768flush = svelte.flushSync;
				w.__dock768 = svelte.mount(dockMod.ThreePaneDock, {
					target,
					props: {
						dock: state,
						left: pane('left'),
						right: pane('right'),
						children: pane('center'),
						persistent: (id: string) => persistent.includes(id)
					}
				});
			},
			{ urls, persistent, tabbed }
		);
		await expect(page.getByLabel('right field 0')).toBeVisible({ timeout: 5_000 });
	}).toPass({ timeout: 60_000 });
}

/** Run a `ThreePaneDock` method by name (not measured). */
async function call(page: Page, op: Operation): Promise<string> {
	return page.evaluate(async (name) => {
		const api = (window as unknown as Record<string, unknown>).__dock768 as {
			float(id: string): Promise<string>;
			dockBack(id: string): Promise<string>;
			move(id: string, target: { tabWith: string }): Promise<string>;
			resetLayout(): Promise<string>;
		};
		if (name === 'float') return api.float('right');
		if (name === 'dockBack') return api.dockBack('right');
		if (name === 'tabWithLeft') return api.move('right', { tabWith: 'left' });
		return api.resetLayout();
	}, op);
}

/**
 * Scroll the right pane's frame and the list inside it, then run `op` and report where they are.
 * `settle: false` runs `op` in the same task as the scroll (its `scroll` events did not fire yet);
 * `focus: true` leaves the focus in a field of the pane (the `moveBefore` path of #763).
 */
async function measure(
	page: Page,
	op: Operation | 'none',
	options: { frame?: number; inner?: number; settle?: boolean; focus?: boolean } = {}
): Promise<ScrollReport> {
	return page.evaluate(
		async ({ name, frameTop, innerTop, settle, focus }) => {
			const api = (window as unknown as Record<string, unknown>).__dock768 as {
				float(id: string): Promise<string>;
				dockBack(id: string): Promise<string>;
				move(id: string, target: { tabWith: string }): Promise<string>;
				resetLayout(): Promise<string>;
			};
			const frameOf = () =>
				document
					.querySelector<HTMLElement>('#dock768 [data-dock-persistent-slot="right"]')!
					.closest<HTMLElement>('.body')!;
			const nextFrame = () =>
				new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
			const content = document.querySelector<HTMLElement>('#dock768 [data-pane="right"]')!;
			const inner = content.querySelector<HTMLElement>('[data-inner="right"]')!;
			const input = content.querySelector<HTMLInputElement>('input[aria-label="right field 9"]')!;
			const before = frameOf();
			if (focus) input.focus({ preventScroll: true });
			before.scrollTop = frameTop;
			inner.scrollTop = innerTop;
			if (settle) await nextFrame();
			const outcome =
				name === 'none'
					? 'none'
					: name === 'float'
						? await api.float('right')
						: name === 'dockBack'
							? await api.dockBack('right')
							: name === 'tabWithLeft'
								? await api.move('right', { tabWith: 'left' })
								: await api.resetLayout();
			// Past the update's microtasks and one frame (a late `scroll` event would show here).
			await nextFrame();
			await nextFrame();
			const after = frameOf();
			return {
				outcome,
				frame: after.scrollTop,
				inner: inner.scrollTop,
				frameRecreated: after !== before,
				sameContent:
					document.querySelector('#dock768 [data-pane="right"]') === content && inner.isConnected,
				activeIsInput: document.activeElement === input
			};
		},
		{
			name: op,
			frameTop: options.frame ?? 150,
			innerTop: options.inner ?? 60,
			settle: options.settle ?? true,
			focus: options.focus ?? false
		}
	);
}

function expectScrollKept(report: ScrollReport, frame = 150, inner = 60): void {
	expect(report.outcome).toBe('applied');
	expect(report.sameContent).toBe(true);
	expect(report.frame).toBe(frame);
	expect(report.inner).toBe(inner);
}

/** Where the right pane's frame and the list inside it are now. */
async function offsets(page: Page): Promise<{ frame: number; inner: number; shown: boolean }> {
	return page.evaluate(() => {
		const slot = document.querySelector<HTMLElement>(
			'#dock768 [data-dock-persistent-slot="right"]'
		)!;
		const inner = document.querySelector<HTMLElement>('#dock768 [data-inner="right"]')!;
		return {
			frame: slot.closest<HTMLElement>('.body')!.scrollTop,
			inner: inner.scrollTop,
			shown: slot.closest('[hidden]') === null
		};
	});
}

test.describe('a persistent pane keeps its scroll position (#768)', () => {
	test.beforeEach(async ({ page }) => {
		await mountHarness(page);
	});

	test('float', async ({ page }) => {
		const report = await measure(page, 'float');
		expect(report.frameRecreated).toBe(true);
		expectScrollKept(report);
	});

	test('dockBack', async ({ page }) => {
		expect(await call(page, 'float')).toBe('applied');
		const report = await measure(page, 'dockBack');
		expect(report.frameRecreated).toBe(true);
		expectScrollKept(report);
	});

	test('move into a tab group', async ({ page }) => {
		expectScrollKept(await measure(page, 'tabWithLeft'));
	});

	test('resetLayout from a floating window', async ({ page }) => {
		expect(await call(page, 'float')).toBe('applied');
		expectScrollKept(await measure(page, 'resetLayout'));
	});

	test('resetLayout from a tab group', async ({ page }) => {
		expect(await call(page, 'tabWithLeft')).toBe('applied');
		expectScrollKept(await measure(page, 'resetLayout'));
	});

	test('with the focus in a field of the pane (moved with moveBefore)', async ({ page }) => {
		expect(await page.evaluate(() => 'moveBefore' in Element.prototype)).toBe(true);
		const floated = await measure(page, 'float', { focus: true });
		expectScrollKept(floated);
		expect(floated.activeIsInput).toBe(true);
		const tabbed = await measure(page, 'tabWithLeft', { frame: 210, inner: 80, focus: true });
		expectScrollKept(tabbed, 210, 80);
		expect(tabbed.activeIsInput).toBe(true);
	});

	test('the offsets are read at the re-arrangement itself (scrolled in the same task)', async ({
		page
	}) => {
		expectScrollKept(await measure(page, 'float', { settle: false }));
		expectScrollKept(
			await measure(page, 'tabWithLeft', { frame: 210, inner: 80, settle: false }),
			210,
			80
		);
	});

	test('a tab switch away and back, each tab with its own offset', async ({ page }) => {
		expect(await call(page, 'tabWithLeft')).toBe('applied');
		expectScrollKept({ ...(await measure(page, 'none')), outcome: 'applied' });
		const tabs = page.locator('#dock768 [role="tab"]');
		await expect(tabs).toHaveCount(2);
		// The right pane was put on top of its group.
		const rightIndex = (await tabs.nth(0).getAttribute('aria-selected')) === 'true' ? 0 : 1;
		const rightTab = tabs.nth(rightIndex);
		const leftTab = tabs.nth(1 - rightIndex);
		await expect(rightTab).toHaveAttribute('aria-selected', 'true');

		// To the left tab (not persistent, re-created: starts at the top of the shared frame).
		await leftTab.click();
		await expect(leftTab).toHaveAttribute('aria-selected', 'true');
		expect((await offsets(page)).shown).toBe(false);
		// Scroll the left tab elsewhere: that is not the right pane's offset.
		await page.evaluate(async () => {
			const frame = document
				.querySelector<HTMLElement>('#dock768 [data-dock-persistent-slot="right"]')!
				.closest<HTMLElement>('.body')!;
			frame.scrollTop = 420;
			await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
		});

		await rightTab.click();
		await expect(rightTab).toHaveAttribute('aria-selected', 'true');
		await expect.poll(async () => (await offsets(page)).shown).toBe(true);
		expect(await offsets(page)).toEqual({ frame: 150, inner: 60, shown: true });
	});

	test('a pane scrolled back to the top stays at the top', async ({ page }) => {
		expectScrollKept(await measure(page, 'float'));
		expectScrollKept(await measure(page, 'dockBack', { frame: 0, inner: 0 }), 0, 0);
	});
});

test('without moveBefore the scroll position comes back as well (#768)', async ({ page }) => {
	await page.addInitScript(() => {
		Reflect.deleteProperty(Element.prototype, 'moveBefore');
	});
	await mountHarness(page);
	expect(await page.evaluate(() => 'moveBefore' in Element.prototype)).toBe(false);
	const floated = await measure(page, 'float', { focus: true });
	expectScrollKept(floated);
	expect(floated.activeIsInput).toBe(true);
	expectScrollKept(await measure(page, 'tabWithLeft', { frame: 210, inner: 80 }), 210, 80);
});

test('two updates in one task: a pane the first one left alone keeps what it was scrolled to in between (#768 review)', async ({
	page
}) => {
	await mountHarness(page, ['left', 'right']);
	const report = await page.evaluate(async () => {
		const w = window as unknown as Record<string, unknown>;
		const state = w.__dock768state as {
			setDockedCollapsed(nodeId: string, collapsed: boolean): void;
			isDockedCollapsed(nodeId: string): boolean;
		};
		const flush = w.__dock768flush as () => void;
		const nextFrame = () =>
			new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
		const frameOf = (id: string) =>
			document
				.querySelector<HTMLElement>(`#dock768 [data-dock-persistent-slot="${id}"]`)!
				.closest<HTMLElement>('.body')!;
		const inner = document.querySelector<HTMLElement>('#dock768 [data-inner="right"]')!;
		const frame = frameOf('right');
		frameOf('left').scrollTop = 90;
		frame.scrollTop = 70;
		inner.scrollTop = 20;
		await nextFrame();
		// A (left) is re-arranged; B (right) stays where it is.
		state.setDockedCollapsed('left', true);
		flush();
		const leftCollapsed = state.isDockedCollapsed('left');
		const stayed = frameOf('right') === frame && frame.scrollTop === 70;
		// B is scrolled on, and re-arranged before its `scroll` event and the first update's microtask.
		frame.scrollTop = 130;
		inner.scrollTop = 50;
		state.setDockedCollapsed('right', true);
		flush();
		const rightCollapsed = state.isDockedCollapsed('right');
		state.setDockedCollapsed('right', false);
		state.setDockedCollapsed('left', false);
		flush();
		await nextFrame();
		await nextFrame();
		return {
			leftCollapsed,
			stayed,
			rightCollapsed,
			right: frameOf('right').scrollTop,
			inner: inner.scrollTop,
			left: frameOf('left').scrollTop
		};
	});
	expect(report).toEqual({
		leftCollapsed: true,
		stayed: true,
		rightCollapsed: true,
		right: 130,
		inner: 50,
		left: 90
	});
});

/**
 * The right pane (long, on top, scrolled to 150) and the left pane (never shown; made so short
 * that their shared frame cannot be scrolled past 30 while it is on top) as the tabs of one
 * group. `steps` runs in the page, in ONE task, with `show(id)` (the tab switch, applied at
 * once) and the shared frame.
 */
async function withShortTab<T>(
	page: Page,
	steps: (tools: {
		show: (id: 'left' | 'right') => void;
		frame: HTMLElement;
		inner: HTMLElement;
		nextFrame: () => Promise<unknown>;
	}) => Promise<T>
): Promise<T> {
	await mountHarness(page, ['left', 'right'], true);
	return page.evaluate(async (source) => {
		const w = window as unknown as Record<string, unknown>;
		const state = w.__dock768state as {
			layout: { docked: unknown };
			setActiveTab(groupId: string, index: number): void;
		};
		const flush = w.__dock768flush as () => void;
		type Node = { type: string; id: string; children?: Node[] };
		const find = (node: Node): Node | null =>
			node.type === 'tabs' ? node : (node.children?.map(find).find(Boolean) ?? null);
		const show = (id: 'left' | 'right') => {
			const group = find(state.layout.docked as Node)!;
			state.setActiveTab(
				group.id,
				group.children!.findIndex((child) => child.id === id)
			);
			flush();
		};
		const nextFrame = () =>
			new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
		const frame = document
			.querySelector<HTMLElement>('#dock768 [data-dock-persistent-slot="right"]')!
			.closest<HTMLElement>('.body')!;
		const inner = document.querySelector<HTMLElement>('#dock768 [data-inner="right"]')!;
		const left = document.querySelector<HTMLElement>('#dock768 [data-pane="left"]')!;
		left.style.cssText = `height:${frame.clientHeight + 30}px;overflow:hidden`;
		frame.scrollTop = 150;
		inner.scrollTop = 60;
		await nextFrame();
		const run = new Function(`return (${source})`)() as typeof steps;
		return run({ show, frame, inner, nextFrame });
	}, steps.toString());
}

test('a short tab shown for the first time starts at the top, not where its frame clamped the offset of the tab before (#768 review)', async ({
	page
}) => {
	const report = await withShortTab(page, async ({ show, frame, nextFrame }) => {
		show('left');
		// Right there: before the code that switched the tab goes on.
		const atOnce = frame.scrollTop;
		const reach = frame.scrollHeight - frame.clientHeight;
		await nextFrame();
		await nextFrame();
		const settled = frame.scrollTop;
		show('right');
		await nextFrame();
		return { atOnce, reach, settled, right: frame.scrollTop };
	});
	expect(report).toEqual({ atOnce: 0, reach: 30, settled: 0, right: 150 });
});

test('a tab switched away and back in one task gets its own offset back (#768 review)', async ({
	page
}) => {
	const report = await withShortTab(page, async ({ show, frame, inner, nextFrame }) => {
		// Right -> left -> right, nothing settled in between; the left tab is scrolled meanwhile.
		show('left');
		frame.scrollTop = 20;
		show('right');
		await nextFrame();
		await nextFrame();
		const right = { frame: frame.scrollTop, inner: inner.scrollTop };
		show('left');
		await nextFrame();
		return { right, left: frame.scrollTop };
	});
	expect(report).toEqual({ right: { frame: 150, inner: 60 }, left: 20 });
});
