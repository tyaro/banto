/**
 * BantoGrid keeps the active cell's row in the DOM while it is outside the
 * virtualized window (#1016), so `aria-activedescendant` always has a target.
 * In a real browser: that one row sits at its own place (out of sight), the
 * rows of the window and the scroll height do not move, the view does not
 * jump, and the first arrow key brings the active cell back into view. The
 * decisions themselves are unit-tested in packages/grid-svelte.
 * Runs against `vite dev` with VITE_BANTO_DEMO=1 (the `demo` project).
 */
import { expect, test } from '@playwright/test';
import { primeThemeAndAuth } from '../visual/theme';

// Cold dev server: first compile / dep optimisation can reload the page.
test.setTimeout(120_000);

test.beforeEach(async ({ page }) => {
	await primeThemeAndAuth(page, { theme: 'light', preset: 'standard' });
});

interface Layout {
	scrollTop: number;
	scrollHeight: number;
	activeId: string | null;
	activeRole: string | null;
	/** Row tops relative to the rows area, by display index. */
	activeRowTop: number | null;
	activeRowIndex: number | null;
	outsideCount: number;
	rowHeight: number;
	/** In-flow rows that are not where their `aria-rowindex` says. */
	misplaced: number;
	inFlowCount: number;
}

test('the active row outside the window stays in the DOM without moving anything', async ({
	page
}) => {
	await page.goto('/items');
	const grid = page.getByRole('grid').first();
	await expect(grid).toBeVisible({ timeout: 60_000 });
	await expect(grid.locator('.row [role="gridcell"]').first()).toBeVisible({ timeout: 60_000 });

	const measure = (): Promise<Layout> =>
		grid.evaluate((el) => {
			const viewport = el.querySelector<HTMLElement>('.rows-viewport')!;
			const top0 = viewport.getBoundingClientRect().top;
			const id = el.getAttribute('aria-activedescendant');
			const active = id ? document.getElementById(id) : null;
			const activeRow = active?.closest<HTMLElement>('.row') ?? null;
			const flow = [...el.querySelectorAll<HTMLElement>('.rows-block > .row:not(.outside-window)')];
			const rowHeight = flow[0].getBoundingClientRect().height;
			const indexOf = (row: HTMLElement) => Number(row.getAttribute('aria-rowindex')) - 2;
			const topOf = (row: HTMLElement) => row.getBoundingClientRect().top - top0;
			return {
				scrollTop: el.scrollTop,
				scrollHeight: el.scrollHeight,
				activeId: id,
				activeRole: active?.getAttribute('role') ?? null,
				activeRowTop: activeRow ? topOf(activeRow) : null,
				activeRowIndex: activeRow ? indexOf(activeRow) : null,
				outsideCount: el.querySelectorAll('.row.outside-window').length,
				rowHeight,
				misplaced: flow.filter((row) => Math.abs(topOf(row) - indexOf(row) * rowHeight) > 0.5)
					.length,
				inFlowCount: flow.length
			};
		});

	// Focus on the grid element puts the cursor on the first cell in view.
	await grid.focus();
	await expect(grid).toHaveAttribute('aria-activedescendant', /.+/);
	const before = await measure();
	expect(before.activeRole).toBe('gridcell');
	expect(before.activeRowIndex).toBe(0);
	expect(before.outsideCount).toBe(0);
	expect(before.misplaced).toBe(0);

	// Far enough that row 0 leaves the window (overscan included).
	const far = before.rowHeight * 200;
	expect(before.scrollHeight).toBeGreaterThan(far * 2);
	await grid.evaluate((el, top) => {
		el.scrollTop = top;
	}, far);
	await expect(grid.locator('.row.outside-window')).toHaveCount(1);
	const scrolled = await measure();
	expect(scrolled.activeId).toBe(before.activeId);
	expect(scrolled.activeRole).toBe('gridcell');
	// At its own place, which is far above what is on screen.
	expect(scrolled.activeRowIndex).toBe(0);
	expect(Math.abs(scrolled.activeRowTop!)).toBeLessThan(0.5);
	// The window's rows and the scroll range are as without it.
	expect(scrolled.misplaced).toBe(0);
	expect(scrolled.inFlowCount).toBeGreaterThan(0);
	expect(scrolled.scrollHeight).toBe(before.scrollHeight);
	expect(scrolled.scrollTop).toBe(far);

	// Leaving and coming back: still named, and the view stays where it was.
	await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
	await grid.focus();
	const refocused = await measure();
	expect(refocused.activeId).toBe(before.activeId);
	expect(refocused.scrollTop).toBe(far);

	// The first arrow key moves from the kept cell and scrolls it into view.
	await page.keyboard.press('ArrowDown');
	await expect(grid.locator('.row.outside-window')).toHaveCount(0);
	const back = await measure();
	expect(back.activeRowIndex).toBe(1);
	expect(back.activeRole).toBe('gridcell');
	expect(back.scrollTop).toBeLessThan(before.rowHeight * 3);
	expect(back.misplaced).toBe(0);
	await expect(page.locator(`[id="${back.activeId}"]`)).toBeInViewport();
});
