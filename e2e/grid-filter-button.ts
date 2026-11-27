import type { Locator, Page } from '@playwright/test';

/**
 * The filter button in a `BantoGrid` column header. Its name is the same in every
 * column (#1035: no column name in it, so that a screen reader reading the header row
 * does not say the column name twice), so it is found through its `columnheader`,
 * whose name is the column's.
 */
export function filterButton(
	scope: Page | Locator,
	columnHeader: string,
	buttonName = '絞り込み'
): Locator {
	return scope
		.getByRole('columnheader', { name: columnHeader, exact: true })
		.getByRole('button', { name: buttonName, exact: true });
}
