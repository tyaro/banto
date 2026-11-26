/**
 * The tab strip of a narrow docked tab group does not overflow (#986): in a 240px-wide
 * `DockHost` with three tabs (titles of 6, 4 and 2 characters) the active tab's menu and close
 * buttons used to push the strip 18px past its width, and the tab at the end was cut off.
 * The tabs now shrink and the titles turn into an ellipsis, whichever tab is in front.
 *
 * jsdom has no layout, so this runs in a real browser. Same harness as the other dock specs:
 * on /tree/workspace-dock the spec imports the package's public entry and `svelte` through the
 * dev server's `/@fs/` and mounts its own `DockHost` in a 240px box.
 */
import { expect, test } from '@playwright/test';
import { primeThemeAndAuth } from '../visual/theme';
import { dockUrls } from './dock-harness';

// Cold dev server: first compile / dep optimisation can reload the page.
test.setTimeout(120_000);
test.use({ viewport: { width: 1280, height: 600 } });

test('a 240px tab strip with three tabs does not overflow, for each front tab', async ({
	page
}) => {
	await primeThemeAndAuth(page, { theme: 'light', preset: 'standard' });
	await page.goto('/tree/workspace-dock');
	await expect(page.getByTestId('workspace-dock-center')).toBeVisible({ timeout: 60_000 });
	// The dev server may reload the page once more while it optimises deps: mount until it holds.
	await expect(async () => {
		const urls = await dockUrls(page);
		await page.evaluate(async (urls) => {
			const w = window as unknown as Record<string, unknown>;
			if (w.__dock986) return;
			const dockMod = await import(/* @vite-ignore */ urls.dock);
			const svelte = await import(/* @vite-ignore */ urls.svelte);
			const panel = (id: string, title: string) => ({ type: 'panel', id, title });
			const content = svelte.createRawSnippet(() => ({ render: () => '<div>body</div>' }));
			// #dock986: the issue's case (the front tab carries ⋯ and ✕). #dock986p also passes
			// `onPopOut`, which adds ⧉: three buttons on the front tab.
			for (const [id, top, popOut] of [
				['dock986', 0, false],
				['dock986p', 310, true]
			] as const) {
				const target = document.createElement('div');
				target.id = id;
				target.style.cssText = `position:fixed;left:0;top:${top}px;width:240px;height:280px;z-index:2147483000;background:#fff`;
				document.body.append(target);
				const state = dockMod.createDockState({
					version: 4,
					floating: [],
					docked: {
						type: 'tabs',
						id: `strip-${id}`,
						activeIndex: 0,
						children: [panel('a', 'Project'), panel('b', 'Tree'), panel('c', 'Ab')]
					}
				});
				const props: Record<string, unknown> = { dock: state, panel: content };
				if (popOut) props.onPopOut = () => {};
				svelte.mount(dockMod.DockHost, { target, props });
			}
			w.__dock986 = true;
		}, urls);
		await expect(page.locator('#dock986 [role="tab"]')).toHaveCount(3, { timeout: 5_000 });
		await expect(page.locator('#dock986p [role="tab"]')).toHaveCount(3, { timeout: 5_000 });
	}).toPass({ timeout: 60_000 });

	for (let i = 0; i < 3; i++) {
		await page.locator('#dock986 [role="tab"]').nth(i).click();
		await expect(page.locator('#dock986 [role="tab"]').nth(i)).toHaveAttribute(
			'aria-selected',
			'true'
		);
		const m = await page.locator('#dock986 .tab-strip').evaluate((el) => ({
			scroll: el.scrollWidth,
			client: el.clientWidth
		}));
		expect(
			m.scroll,
			`front tab ${i}: strip content ${m.scroll}px in ${m.client}px`
		).toBeLessThanOrEqual(m.client);
	}
	// The full title stays reachable.
	await expect(page.locator('#dock986 [role="tab"] .title').first()).toHaveAttribute(
		'title',
		'Project'
	);

	// Touch density (40px buttons): the front tab never shrinks below its own buttons, so ⋯, ⧉ and ✕
	// stay inside the tab (the strip scrolls instead of clipping them or overlapping a neighbour).
	await page.evaluate(() => (document.documentElement.dataset.bantoDensity = 'touch'));
	for (let i = 0; i < 3; i++) {
		await page.locator('#dock986p [role="tab"]').nth(i).click();
		const fit = await page
			.locator('#dock986p [role="tab"]')
			.nth(i)
			.evaluate((tab) => {
				const box = tab.getBoundingClientRect();
				return [...tab.querySelectorAll('button')].map((b) => {
					const r = b.getBoundingClientRect();
					return { left: r.left - box.left, right: box.right - r.right, width: r.width };
				});
			});
		expect(fit.length, `front tab ${i}: its buttons`).toBe(3);
		for (const b of fit) {
			expect(b.width, `front tab ${i}: touch button size`).toBeGreaterThanOrEqual(39);
			expect(b.left, `front tab ${i}: button inside the tab`).toBeGreaterThanOrEqual(0);
			expect(b.right, `front tab ${i}: button inside the tab`).toBeGreaterThanOrEqual(0);
		}
	}
});
