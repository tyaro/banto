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
			const target = document.createElement('div');
			target.id = 'dock986';
			target.style.cssText =
				'position:fixed;left:0;top:0;width:240px;height:300px;z-index:2147483000;background:#fff';
			document.body.append(target);
			const panel = (id: string, title: string) => ({ type: 'panel', id, title });
			const state = dockMod.createDockState({
				version: 4,
				floating: [],
				docked: {
					type: 'tabs',
					id: 'strip986',
					activeIndex: 0,
					children: [panel('a', 'Project'), panel('b', 'Tree'), panel('c', 'Ab')]
				}
			});
			const content = svelte.createRawSnippet(() => ({ render: () => '<div>body</div>' }));
			w.__dock986 = svelte.mount(dockMod.DockHost, {
				target,
				props: { dock: state, panel: content }
			});
		}, urls);
		await expect(page.locator('#dock986 [role="tab"]')).toHaveCount(3, { timeout: 5_000 });
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
});
