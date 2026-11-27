/**
 * What a screen reader is given in a pop-out panel window (Issue #1024), as far as a browser
 * can show it - the reading itself is checked with NVDA on a desktop.
 *
 * 1. The document's title while the app is still starting. The `banto-tauri-panel` plugin
 *    hands the window a script that names the document after the panel before the page's own
 *    scripts run (`crates/banto-tauri-panel/src/title.js`); here the same text is installed
 *    with `addInitScript`, the way Tauri's `initialization_script` runs it.
 * 2. "clickable". Chromium gives an element with a click listener the default action
 *    "click", and NVDA says "clickable" for it. Svelte delegates its events to the element the
 *    app is mounted on (app.html's wrapper), so that wrapper must stay out of the
 *    accessibility tree.
 */
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { DIAGONAL_MATRIX, primeThemeAndAuth } from './theme';

const ja: Record<string, string> = JSON.parse(
	readFileSync(new URL('../../apps/admin-template/messages/ja.json', import.meta.url), 'utf8')
);
const PANEL_TITLE = ja['panels.monthly'];

/** `document_title_script` of `crates/banto-tauri-panel/src/title.rs`, composed the same way. */
function documentTitleScript(title: string): string {
	const fn = readFileSync(
		new URL('../../crates/banto-tauri-panel/src/title.js', import.meta.url),
		'utf8'
	)
		.trimEnd()
		.replace(/;$/, '');
	return `${fn}(${JSON.stringify(title)});`;
}

/**
 * Records every title the document has had, from the first moment a `<title>` exists. Its
 * observer is created after the plugin's script has run (init scripts run in the order they
 * were added), so it sees what is left once that script has reacted to the same change.
 */
async function recordTitles(page: Page): Promise<void> {
	await page.addInitScript(() => {
		const seen: string[] = [];
		(window as unknown as { __titles: string[] }).__titles = seen;
		const note = () => {
			if (!document.querySelector('title')) return;
			if (seen[seen.length - 1] !== document.title) seen.push(document.title);
		};
		new MutationObserver(note).observe(document, {
			childList: true,
			subtree: true,
			characterData: true
		});
		document.addEventListener('DOMContentLoaded', note);
	});
}

const titlesOf = (page: Page) =>
	page.evaluate(() => (window as unknown as { __titles: string[] }).__titles);

/** Whether Chromium leaves the element the app is mounted on out of the accessibility tree. */
async function mountTargetIsIgnored(page: Page): Promise<boolean> {
	const cdp = await page.context().newCDPSession(page);
	await cdp.send('Accessibility.enable');
	const { result } = await cdp.send('Runtime.evaluate', {
		expression: 'document.body.firstElementChild'
	});
	const { nodes } = await cdp.send('Accessibility.getPartialAXTree', {
		objectId: result.objectId,
		fetchRelatives: false
	});
	await cdp.detach();
	return nodes[0].ignored;
}

test.describe('panel window: what a screen reader is given (#1024)', () => {
	test('the document is named after the panel from the start, and the name never changes', async ({
		page
	}) => {
		await primeThemeAndAuth(page, DIAGONAL_MATRIX[0]);
		await page.addInitScript(documentTitleScript(PANEL_TITLE));
		await recordTitles(page);
		await page.goto('/panel/monthly');
		await expect(page.getByRole('banner')).toHaveText(PANEL_TITLE);
		await expect(page).toHaveTitle(PANEL_TITLE);
		expect(await titlesOf(page)).toEqual([PANEL_TITLE]);
	});

	test("the page's own title replaces the one the window was opened with", async ({ page }) => {
		// A window opened with another text (the app's language was changed since, say).
		await primeThemeAndAuth(page, DIAGONAL_MATRIX[0]);
		await page.addInitScript(documentTitleScript('Monthly "updates" \\ </title>'));
		await recordTitles(page);
		await page.goto('/panel/monthly');
		await expect(page).toHaveTitle(PANEL_TITLE);
		expect(await titlesOf(page)).toEqual(['Monthly "updates" \\ </title>', PANEL_TITLE]);
	});

	test('without the script, the shell title is what the document starts with', async ({ page }) => {
		// The gap the plugin closes - and the proof that `recordTitles` can see it.
		await primeThemeAndAuth(page, DIAGONAL_MATRIX[0]);
		await recordTitles(page);
		await page.goto('/panel/monthly');
		await expect(page).toHaveTitle(PANEL_TITLE);
		expect(await titlesOf(page)).toEqual(['Banto', PANEL_TITLE]);
	});

	for (const path of ['/panel/monthly', '/dashboard']) {
		test(`the element the app is mounted on is not exposed as clickable (${path})`, async ({
			page
		}) => {
			await primeThemeAndAuth(page, DIAGONAL_MATRIX[0]);
			await page.goto(path);
			await expect(page.getByRole(path === '/dashboard' ? 'main' : 'banner')).toBeVisible();
			// The premise: Svelte's delegated click listener sits on this element.
			await expect(page.locator('body > div').first()).toHaveAttribute('role', 'presentation');
			expect(await mountTargetIsIgnored(page)).toBe(true);
		});
	}
});
