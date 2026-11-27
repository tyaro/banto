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

/**
 * Review of #1031: the kept row's controls — the row's "open" button here,
 * which the list draws with `column.render` — are no tab stops while the row
 * is out of sight, so Tab from the header goes on to what is on screen and
 * the view does not jump back to the kept row.
 */
test('Tab skips the controls of the active row kept outside the window', async ({ page }) => {
	await page.goto('/items');
	const grid = page.getByRole('grid').first();
	await expect(grid).toBeVisible({ timeout: 60_000 });
	await expect(grid.locator('.row [role="gridcell"]').first()).toBeVisible({ timeout: 60_000 });

	interface Stop {
		scrollTop: number;
		/** Display index of the row the focus is in, or null (header, outside the grid). */
		rowIndex: number | null;
		inOutsideRow: boolean;
		inGrid: boolean;
		isOpenButton: boolean;
	}
	const stop = (): Promise<Stop> =>
		grid.evaluate((el) => {
			const focused = document.activeElement as HTMLElement | null;
			const row = focused?.closest<HTMLElement>('.rows-block > .row') ?? null;
			return {
				scrollTop: el.scrollTop,
				rowIndex: row ? Number(row.getAttribute('aria-rowindex')) - 2 : null,
				inOutsideRow: row?.classList.contains('outside-window') ?? false,
				inGrid: !!focused && el.contains(focused) && focused !== el,
				isOpenButton: !!focused?.closest('[data-resource-open]')
			};
		});
	/** Tab from the grid element until the focus is in a data row (or has left the grid). */
	const tabIntoRows = async (): Promise<Stop[]> => {
		await grid.focus();
		const stops: Stop[] = [];
		for (let i = 0; i < 80; i++) {
			await page.keyboard.press('Tab');
			const at = await stop();
			stops.push(at);
			if (at.rowIndex !== null || !at.inGrid) break;
		}
		return stops;
	};
	/** `tabindex` of the controls of row 0 (the kept row, wherever it is drawn). */
	const controlTabindexes = () =>
		grid.evaluate((el) =>
			[
				...el.querySelectorAll<HTMLElement>(
					'.row[aria-rowindex="2"] :is([data-resource-open] button, a[href], input)'
				)
			].map((control) => control.getAttribute('tabindex'))
		);

	// Row 0 is the active row, in the window: its controls are tab stops.
	await grid.focus();
	await expect(grid).toHaveAttribute('aria-activedescendant', /.+/);
	const original = await controlTabindexes();
	expect(original.length).toBeGreaterThan(0);
	expect(original).not.toContain('-1');
	const firstStops = await tabIntoRows();
	const first = firstStops.at(-1)!;
	expect(first.rowIndex).toBe(0);

	const rowHeight = await grid.evaluate(
		(el) => el.querySelector<HTMLElement>('.rows-block > .row')!.getBoundingClientRect().height
	);
	const far = rowHeight * 200;
	await grid.evaluate((el, top) => {
		el.scrollTop = top;
	}, far);
	await expect(grid.locator('.row.outside-window')).toHaveCount(1);
	// Every control of the kept row is out of the Tab order; the row itself
	// stays exposed (no `inert`, no `aria-hidden`).
	const outside = await controlTabindexes();
	expect(outside).toHaveLength(original.length);
	expect(outside.every((value) => value === '-1')).toBe(true);
	await expect(
		grid.locator('.row.outside-window[inert], .row.outside-window[aria-hidden]')
	).toHaveCount(0);
	await expect(grid.locator('.row.outside-window [data-resource-open] button')).toHaveCount(1);

	// Tab from the grid element, through the header, into the rows: never into
	// the kept row, and the view stays where it was scrolled to.
	const stops = await tabIntoRows();
	const landed = stops.at(-1)!;
	expect(stops.some((at) => at.inOutsideRow)).toBe(false);
	expect(landed.rowIndex).not.toBeNull();
	expect(landed.rowIndex!).toBeGreaterThan(100);
	// Through the header nothing scrolls. The first tab stop of the rows is the
	// window's first row, which is overscan just above the fold: the browser
	// brings it into view (as it did before #1016). The jump this guards
	// against is the one all the way back to row 0.
	for (const at of stops.slice(0, -1)) expect(at.scrollTop).toBe(far);
	expect(far - landed.scrollTop).toBeGreaterThanOrEqual(0);
	expect(far - landed.scrollTop).toBeLessThan(rowHeight * 30);
	await expect(grid.locator('.row.outside-window')).toHaveCount(1);

	// Back in the window, the row's controls are tab stops again, as before.
	await grid.evaluate((el) => {
		el.scrollTop = 0;
	});
	await expect(grid.locator('.row.outside-window')).toHaveCount(0);
	await expect(grid.locator('[data-banto-grid-tabindex]')).toHaveCount(0);
	expect(await controlTabindexes()).toEqual(original);
	const backStops = await tabIntoRows();
	const back = backStops.at(-1)!;
	expect(back.rowIndex).toBe(0);
	expect(back.isOpenButton).toBe(first.isOpenButton);
	expect(backStops).toHaveLength(firstStops.length);
});
