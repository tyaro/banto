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
 * Nothing inside a row is a tab stop (#1016 item 5: the body's tab stop is the
 * grid element), and that holds for the active row kept outside the window
 * too: Tab from the grid element goes to the header and then out of the grid,
 * never into the kept row, and the view stays where it was scrolled to.
 */
test('Tab never lands in the active row kept outside the window', async ({ page }) => {
	await page.goto('/items');
	const grid = page.getByRole('grid').first();
	await expect(grid).toBeVisible({ timeout: 60_000 });
	await expect(grid.locator('.row [role="gridcell"]').first()).toBeVisible({ timeout: 60_000 });

	interface Stop {
		scrollTop: number;
		inRow: boolean;
		inHeader: boolean;
		inGrid: boolean;
	}
	const stop = (): Promise<Stop> =>
		grid.evaluate((el) => {
			const focused = document.activeElement as HTMLElement | null;
			return {
				scrollTop: el.scrollTop,
				inRow: !!focused?.closest('.rows-block > .row'),
				inHeader: !!focused?.closest('.header-row'),
				inGrid: !!focused && el.contains(focused) && focused !== el
			};
		});
	/** Tab from the grid element until the focus has left the grid. */
	const tabThrough = async (): Promise<Stop[]> => {
		await grid.focus();
		const stops: Stop[] = [];
		for (let i = 0; i < 10; i++) {
			await page.keyboard.press('Tab');
			const at = await stop();
			stops.push(at);
			if (!at.inGrid) break;
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

	// Row 0 is the active row, in the window: its controls are not tab stops.
	await grid.focus();
	await expect(grid).toHaveAttribute('aria-activedescendant', /.+/);
	await expect
		.poll(async () => {
			const values = await controlTabindexes();
			return values.length > 0 && values.every((value) => value === '-32768');
		})
		.toBe(true);
	const original = await controlTabindexes();
	const firstStops = await tabThrough();
	// One stop in the header, then out.
	expect(firstStops.map((at) => at.inHeader)).toEqual([true, false]);
	expect(firstStops.some((at) => at.inRow)).toBe(false);

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
	expect(outside.every((value) => value === '-32768')).toBe(true);
	await expect(
		grid.locator('.row.outside-window[inert], .row.outside-window[aria-hidden]')
	).toHaveCount(0);
	await expect(grid.locator('.row.outside-window [data-resource-open] button')).toHaveCount(1);

	// The same two stops, and nothing scrolls: not back to row 0, not anywhere.
	const stops = await tabThrough();
	expect(stops.map((at) => at.inHeader)).toEqual([true, false]);
	expect(stops.some((at) => at.inRow)).toBe(false);
	for (const at of stops) expect(at.scrollTop).toBe(far);
	await expect(grid.locator('.row.outside-window')).toHaveCount(1);

	// Back in the window nothing changed for the row's controls.
	await grid.evaluate((el) => {
		el.scrollTop = 0;
	});
	await expect(grid.locator('.row.outside-window')).toHaveCount(0);
	expect(await controlTabindexes()).toEqual(original);
	expect((await tabThrough()).map((at) => at.inHeader)).toEqual([true, false]);
});

/**
 * Review of #1031: the focus is never left inside the kept row. A control
 * there is out of sight, yet Enter would still press it (the row's "open"
 * button opened the drawer of a record the user could not see). The grid
 * element takes the focus instead, and nothing scrolls.
 */
test.describe('focus does not stay in the active row kept outside the window', () => {
	const openButtonOfRow0 = '.row[aria-rowindex="2"] [data-resource-open] button';

	async function openItems(page: import('@playwright/test').Page) {
		await page.goto('/items');
		const grid = page.getByRole('grid').first();
		await expect(grid).toBeVisible({ timeout: 60_000 });
		await expect(grid.locator('.row [role="gridcell"]').first()).toBeVisible({ timeout: 60_000 });
		// Row 0 becomes the active row.
		await grid.focus();
		await expect(grid).toHaveAttribute('aria-activedescendant', /.+/);
		return grid;
	}

	const focusState = (grid: import('@playwright/test').Locator) =>
		grid.evaluate((el) => {
			const focused = document.activeElement;
			return {
				onGrid: focused === el,
				inOutsideRow: !!focused?.closest('.row.outside-window'),
				scrollTop: el.scrollTop,
				activeRowIndex:
					Number(
						document
							.getElementById(el.getAttribute('aria-activedescendant') ?? '')
							?.closest('.row')
							?.getAttribute('aria-rowindex')
					) - 2
			};
		});

	test('a wheel scroll with the "open" button focused hands the focus to the grid', async ({
		page
	}) => {
		const grid = await openItems(page);
		const isOnOpenButton = () =>
			grid.evaluate(
				(el, selector) => document.activeElement === el.querySelector(selector),
				openButtonOfRow0
			);
		// The button is not a tab stop (#1016 item 5): F2 on its cell, the first
		// of the row, moves the focus into it.
		await page.keyboard.press('Home');
		await page.keyboard.press('F2');
		expect(await isOnOpenButton()).toBe(true);

		const box = (await grid.boundingBox())!;
		await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
		await page.mouse.wheel(0, 8_000);
		await expect(grid.locator('.row.outside-window')).toHaveCount(1);
		await expect.poll(async () => (await focusState(grid)).onGrid).toBe(true);
		const scrolled = await focusState(grid);
		expect(scrolled.scrollTop).toBeGreaterThan(4_000);
		expect(scrolled.activeRowIndex).toBe(0);

		// A key no longer goes to the button that is out of sight: the grid
		// element gets it, as the action on the active cell (which is what a
		// screen reader has announced). On this list Enter on a cell opens the
		// record, so the drawer itself is no evidence either way.
		await page.evaluate(() => {
			const w = window as unknown as { __keyTargets: (string | null)[] };
			w.__keyTargets = [];
			document.addEventListener(
				'keydown',
				(event) => w.__keyTargets.push((event.target as Element).getAttribute('role')),
				true
			);
		});
		await page.keyboard.press('Enter');
		expect(
			await page.evaluate(
				() => (window as unknown as { __keyTargets: (string | null)[] }).__keyTargets
			)
		).toEqual(['grid']);
	});

	for (const moved of [false, true]) {
		test(`closing the drawer ${moved ? 'after moving to the next record ' : ''}with the row scrolled out gives the focus to the grid, without a jump`, async ({
			page
		}) => {
			const grid = await openItems(page);
			await grid.locator(openButtonOfRow0).click();
			const drawer = page.getByRole('dialog');
			await expect(drawer).toBeVisible();
			if (moved) {
				const before = page.url();
				await page.keyboard.press('Alt+ArrowDown');
				await expect.poll(() => page.url()).not.toBe(before);
			}

			const rowHeight = await grid.evaluate(
				(el) => el.querySelector<HTMLElement>('.rows-block > .row')!.getBoundingClientRect().height
			);
			const far = rowHeight * 200;
			await grid.evaluate((el, top) => {
				el.scrollTop = top;
			}, far);
			await expect(grid.locator('.row.outside-window')).toHaveCount(1);
			// Every scroll event from here on is recorded. The drawer hands the
			// focus back with a plain focus(), which scrolls to the row before the
			// grid can refuse it; the grid puts the position back in the same task,
			// so the event that follows reports the old position and nothing else
			// was ever painted.
			await grid.evaluate((el) => {
				const w = window as unknown as { __gridScrolls: number[] };
				w.__gridScrolls = [];
				el.addEventListener('scroll', () => w.__gridScrolls.push(el.scrollTop));
			});

			await page.keyboard.press('Escape');
			await expect(drawer).toHaveCount(0);
			await expect.poll(async () => (await focusState(grid)).onGrid).toBe(true);
			await page.waitForTimeout(300);
			const closed = await focusState(grid);
			expect(closed.onGrid).toBe(true);
			expect(closed.inOutsideRow).toBe(false);
			expect(closed.scrollTop).toBe(far);
			const scrolls = await page.evaluate(
				() => (window as unknown as { __gridScrolls: number[] }).__gridScrolls
			);
			expect(scrolls.filter((top) => top !== far)).toEqual([]);
			await expect(grid.locator('.row.outside-window')).toHaveCount(1);
		});
	}
});
