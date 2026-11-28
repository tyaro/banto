/**
 * Issue #1044 (WCAG 1.4.4 / 1.4.10): with the root text size at 200% the
 * page must not scroll sideways at 320px, the header's search pill must hold its
 * "Ctrl+K", and a small button's label must stay inside its frame. Judged by
 * numbers, not screenshots (no baseline images). The LAN-only parts (the
 * connection banner, the conflict dialog) are checked in smoke.spec.ts.
 */
import { expect, test, type Page } from '@playwright/test';
import { DIAGONAL_MATRIX, primeThemeAndAuth } from './theme';

async function open(page: Page, path: string, width: number): Promise<void> {
	await primeThemeAndAuth(page, DIAGONAL_MATRIX[0]);
	await page.setViewportSize({ width, height: 800 });
	await page.goto(path);
	await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
	await page.evaluate(() => (document.documentElement.style.fontSize = '200%'));
}

/** Elements whose right edge passes the viewport (what makes the page scroll), for the failure message. */
async function stray(page: Page): Promise<string[]> {
	return page.evaluate(() => {
		const limit = document.documentElement.clientWidth;
		const out: string[] = [];
		for (const el of document.body.querySelectorAll('*')) {
			const r = el.getBoundingClientRect();
			if (r.width > 0 && r.right > limit + 1) {
				out.push(
					`${el.tagName.toLowerCase()}.${(el as HTMLElement).className} ${Math.round(r.right)}`
				);
			}
		}
		return out.slice(0, 8);
	});
}

for (const path of ['/items', '/dashboard']) {
	test(`${path} does not scroll sideways at 320px and 200% text`, async ({ page }) => {
		await open(page, path, 320);
		const widths = await page.evaluate(() => ({
			scroll: document.documentElement.scrollWidth,
			client: document.documentElement.clientWidth
		}));
		expect(widths.scroll, (await stray(page)).join('\n')).toBeLessThanOrEqual(widths.client);
	});
}

test('the header search pill keeps its shortcut inside the frame at 200% text', async ({
	page
}) => {
	await open(page, '/items', 1280);
	const pill = page.locator('.search-pill');
	await expect(pill).toBeVisible();
	const gap = await pill.evaluate((el) => {
		const kbd = el.querySelector('kbd')!.getBoundingClientRect();
		const r = el.getBoundingClientRect();
		return {
			top: kbd.top - r.top,
			bottom: r.bottom - kbd.bottom,
			left: kbd.left - r.left,
			right: r.right - kbd.right
		};
	});
	expect(gap.top).toBeGreaterThanOrEqual(0);
	expect(gap.bottom).toBeGreaterThanOrEqual(0);
	expect(gap.left).toBeGreaterThanOrEqual(0);
	expect(gap.right).toBeGreaterThanOrEqual(0);
});

test('the header search pill keeps the control height at 100% text', async ({ page }) => {
	await open(page, '/items', 1440);
	await page.evaluate(() => (document.documentElement.style.fontSize = ''));
	const m = await page.locator('.search-pill').evaluate((el) => ({
		pill: el.getBoundingClientRect().height,
		kbd: el.querySelector('kbd')!.getBoundingClientRect().height
	}));
	expect(m.pill, JSON.stringify(m)).toBe(28);
	// The shortcut keeps its themed padding, so it sits just inside the 28px frame.
	expect(m.pill - m.kbd, JSON.stringify(m)).toBeGreaterThanOrEqual(0);
});

test('a small button grows with its label instead of overflowing at 200% text', async ({
	page
}) => {
	await open(page, '/items', 320);
	const result = await page.evaluate(() => {
		const row = document.createElement('div');
		row.style.cssText =
			'display:flex;gap:8px;width:200px;position:fixed;top:0;left:0;z-index:99999';
		row.innerHTML =
			'<button class="banto-btn banto-btn--secondary banto-btn--sm">Retry the connection</button>' +
			'<button class="banto-btn banto-btn--primary banto-btn--sm">Save the chosen values</button>';
		document.body.append(row);
		const buttons = [...row.querySelectorAll('button')];
		const [a, b] = buttons.map((x) => x.getBoundingClientRect());
		return {
			fits: buttons.every((x) => x.scrollHeight <= x.clientHeight),
			overlap: a.right > b.left + 1 && a.bottom > b.top + 1 && b.bottom > a.top + 1
		};
	});
	expect(result.fits).toBe(true);
	expect(result.overlap).toBe(false);
});
