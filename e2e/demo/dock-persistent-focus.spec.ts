/**
 * A `persistent` pane of `ThreePaneDock` keeps the focus of the field inside it through a
 * re-arrangement (#763): `float` / `dockBack` / `move({ tabWith })` / `resetLayout` fire no
 * `blur` / `focusout` on the focused input and `document.activeElement` stays that input
 * (`Element.moveBefore()`, Chromium 133+). Without `moveBefore` the `blur` cannot be avoided, and
 * `isDockRearranging` tells it from the user leaving the field.
 *
 * jsdom fires no `blur` when a focused element leaves the document, so this runs in a real
 * browser. The example is not an app route: on /tree/workspace-dock (a page that already loads
 * `@banto/dock-svelte`, so the dev server serves its entry) the spec imports the package's public
 * entry and `svelte` through the dev server's `/@fs/` (the `demo` project runs `vite dev`) and
 * mounts its own `ThreePaneDock` with a `persistent` right pane over the page.
 */
import { expect, test, type Page } from '@playwright/test';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { primeThemeAndAuth } from '../visual/theme';

// Cold dev server: first compile / dep optimisation can reload the page.
test.setTimeout(120_000);

const dockDir = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	'../../packages/dock-svelte'
);
const svelteDir = path.dirname(
	createRequire(path.join(dockDir, 'package.json')).resolve('svelte/package.json')
);
const fsUrl = (file: string): string => `/@fs/${file.replaceAll('\\', '/').replace(/^\//, '')}`;
/** The same module URLs the app's own imports resolve to (one Svelte runtime on the page). */
const URLS = {
	dock: fsUrl(path.join(dockDir, 'src/index.ts')),
	svelte: fsUrl(path.join(svelteDir, 'src/index-client.js'))
};

type Operation = 'float' | 'dockBack' | 'tabWithLeft' | 'resetLayout';

interface FocusReport {
	outcome: string;
	events: string[];
	/** `isDockRearranging(input)` at each `blur`. */
	rearrangingAtBlur: boolean[];
	activeIsInput: boolean;
	sameElement: boolean;
	value: string;
	selection: [number | null, number | null];
	rearrangingAfter: boolean;
}

async function mountHarness(page: Page): Promise<void> {
	await primeThemeAndAuth(page, { theme: 'light', preset: 'standard' });
	await page.goto('/tree/workspace-dock');
	await expect(page.getByTestId('workspace-dock-center')).toBeVisible({ timeout: 60_000 });
	// The dev server may reload the page once more while it optimises deps: mount until it holds.
	await expect(async () => {
		await page.evaluate(async (urls) => {
			const w = window as unknown as Record<string, unknown>;
			if (w.__dock763) return;
			const dockMod = await import(/* @vite-ignore */ urls.dock);
			const svelte = await import(/* @vite-ignore */ urls.svelte);
			const pane = (name: string) =>
				svelte.createRawSnippet(() => ({
					render: () => `<div data-pane="${name}">${name}<input aria-label="${name} input" /></div>`
				}));
			const target = document.createElement('div');
			target.style.cssText = 'position:fixed;inset:0;z-index:2147483000;background:#fff';
			document.body.append(target);
			w.__dock763 = svelte.mount(dockMod.ThreePaneDock, {
				target,
				props: {
					dock: dockMod.createDockState(),
					left: pane('left'),
					right: pane('right'),
					children: pane('center'),
					persistent: (id: string) => id === 'right'
				}
			});
			w.__dock763mod = dockMod;
		}, URLS);
		await expect(page.getByLabel('right input')).toBeVisible({ timeout: 5_000 });
	}).toPass({ timeout: 60_000 });
}

/** Run a `ThreePaneDock` method by name (not measured). */
async function call(page: Page, op: Operation): Promise<string> {
	return page.evaluate(async (name) => {
		const api = (window as unknown as Record<string, unknown>).__dock763 as {
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

/** Focus the right pane's input (typed `12.`, caret at the end), run `op`, report what the input saw. */
async function measure(page: Page, op: Operation): Promise<FocusReport> {
	const input = page.getByLabel('right input');
	await input.fill('12.');
	await input.focus();
	await expect(input).toBeFocused();
	return page.evaluate(async (name) => {
		const w = window as unknown as Record<string, unknown>;
		const api = w.__dock763 as {
			float(id: string): Promise<string>;
			dockBack(id: string): Promise<string>;
			move(id: string, target: { tabWith: string }): Promise<string>;
			resetLayout(): Promise<string>;
		};
		const { isDockRearranging } = w.__dock763mod as {
			isDockRearranging(node: Node): boolean;
		};
		const el = document.querySelector<HTMLInputElement>('input[aria-label="right input"]')!;
		el.setSelectionRange(1, 3);
		const events: string[] = [];
		const rearrangingAtBlur: boolean[] = [];
		const record = (event: Event) => {
			events.push(event.type);
			if (event.type === 'blur') rearrangingAtBlur.push(isDockRearranging(el));
		};
		const types = ['blur', 'focusout', 'focus', 'focusin'];
		for (const type of types) el.addEventListener(type, record);
		const outcome =
			name === 'float'
				? await api.float('right')
				: name === 'dockBack'
					? await api.dockBack('right')
					: name === 'tabWithLeft'
						? await api.move('right', { tabWith: 'left' })
						: await api.resetLayout();
		// Past the update's microtasks and one frame (a late focus fix-up would show here).
		await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
		for (const type of types) el.removeEventListener(type, record);
		const now = document.querySelector<HTMLInputElement>('input[aria-label="right input"]');
		return {
			outcome,
			events,
			rearrangingAtBlur,
			activeIsInput: document.activeElement === el,
			sameElement: now === el && el.isConnected,
			value: el.value,
			selection: [el.selectionStart, el.selectionEnd] as [number | null, number | null],
			rearrangingAfter: isDockRearranging(el)
		};
	}, op);
}

function expectFocusKept(report: FocusReport): void {
	expect(report.outcome).toBe('applied');
	expect(report.events).toEqual([]);
	expect(report.activeIsInput).toBe(true);
	expect(report.sameElement).toBe(true);
	expect(report.value).toBe('12.');
	expect(report.selection).toEqual([1, 3]);
	expect(report.rearrangingAfter).toBe(false);
}

test.describe('a persistent pane keeps the focus through a re-arrangement (#763)', () => {
	test.beforeEach(async ({ page }) => {
		await mountHarness(page);
		expect(await page.evaluate(() => 'moveBefore' in Element.prototype)).toBe(true);
		expect(await page.evaluate(() => document.hasFocus())).toBe(true);
	});

	test('float', async ({ page }) => {
		expectFocusKept(await measure(page, 'float'));
	});

	test('dockBack', async ({ page }) => {
		expect(await call(page, 'float')).toBe('applied');
		expectFocusKept(await measure(page, 'dockBack'));
	});

	test('move into a tab group', async ({ page }) => {
		expectFocusKept(await measure(page, 'tabWithLeft'));
	});

	test('resetLayout from a floating window', async ({ page }) => {
		expect(await call(page, 'float')).toBe('applied');
		expectFocusKept(await measure(page, 'resetLayout'));
	});

	test('resetLayout from a tab group', async ({ page }) => {
		expect(await call(page, 'tabWithLeft')).toBe('applied');
		expectFocusKept(await measure(page, 'resetLayout'));
	});
});

test('without moveBefore the blur is marked as a re-arrangement and the focus comes back (#763)', async ({
	page
}) => {
	await page.addInitScript(() => {
		Reflect.deleteProperty(Element.prototype, 'moveBefore');
	});
	await mountHarness(page);
	expect(await page.evaluate(() => 'moveBefore' in Element.prototype)).toBe(false);

	const report = await measure(page, 'float');
	expect(report.outcome).toBe('applied');
	// The old path: the focus is lost and put back (README "据え置き").
	expect(report.events).toEqual(['blur', 'focusout', 'focus', 'focusin']);
	expect(report.rearrangingAtBlur).toEqual([true]);
	expect(report.rearrangingAfter).toBe(false);
	expect(report.activeIsInput).toBe(true);
	expect(report.sameElement).toBe(true);
	expect(report.value).toBe('12.');
});
