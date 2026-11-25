/**
 * #964 G1 (grid-touch-edit-design §3): tap to edit with a real browser's touch
 * input. jsdom has no default actions: only here does a tap's compatibility
 * `mousedown` try to move focus to the grid before the `click`.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { expect, test, type Page } from '@playwright/test';

const prefix = '/__grid-tap-edit-fixture/';
const requireGrid = createRequire(
	new URL('../../packages/grid-svelte/package.json', import.meta.url)
);
const themeCss = readFileSync(
	new URL('../../packages/theme/src/css/banto.css', import.meta.url),
	'utf8'
).replace(
	"@import './banto-glass.css';",
	readFileSync(new URL('../../packages/theme/src/css/banto-glass.css', import.meta.url), 'utf8')
);
let bundleDir: string;

test.use({ hasTouch: true });

test.beforeAll(async () => {
	bundleDir = mkdtempSync(path.join(tmpdir(), 'banto-grid-tap-edit-'));
	// Use the grid's existing dev dependency, without adding a root/runtime dependency.
	const { build } = await import(pathToFileURL(requireGrid.resolve('vite')).href);
	await build({
		configFile: fileURLToPath(
			new URL('../../packages/grid-svelte/tests/browser/tap-edit/vite.config.mjs', import.meta.url)
		),
		build: { outDir: bundleDir, emptyOutDir: true },
		logLevel: 'warn'
	});
});
test.afterAll(() => {
	if (bundleDir) rmSync(bundleDir, { recursive: true, force: true });
});

async function start(page: Page) {
	await page.route(`**${prefix}**`, async (route) => {
		const relative =
			decodeURIComponent(new URL(route.request().url()).pathname.slice(prefix.length)) ||
			'index.html';
		const filename = path.resolve(bundleDir, relative);
		if (!filename.startsWith(`${bundleDir}${path.sep}`)) return route.abort();
		await route.fulfill({
			path: filename,
			contentType: filename.endsWith('.js')
				? 'application/javascript'
				: filename.endsWith('.css')
					? 'text/css'
					: 'text/html'
		});
	});
	await page.goto(prefix);
	await page.addStyleTag({ content: themeCss });
	const grid = page.getByRole('grid');
	await expect(grid).toBeVisible();
	return {
		grid,
		edits: page.getByTestId('edits'),
		cell: (row: number, field: string) =>
			grid.locator(`[data-cell-row="${row}"][data-cell-field="${field}"]`)
	};
}

test('one tap starts editing; a mouse click only selects', async ({ page }) => {
	const { grid, cell } = await start(page);
	await cell(1, 'name').click();
	await expect(cell(1, 'name')).toHaveClass(/active/);
	await expect(grid.locator('.cell-editor')).toHaveCount(0);

	await cell(2, 'name').tap();
	const editor = cell(2, 'name').getByRole('textbox');
	await expect(editor).toBeFocused();
	await expect(editor).toHaveValue('Name 3');
});

test('a tap on a read-only cell commits the open editor and selects', async ({ page }) => {
	const { grid, cell, edits } = await start(page);
	await cell(0, 'name').tap();
	await cell(0, 'name').getByRole('textbox').fill('Renamed');
	await cell(3, 'note').tap();
	await expect(edits).toHaveText('1');
	await expect(cell(0, 'name')).toHaveText('Renamed');
	await expect(cell(3, 'note')).toHaveClass(/active/);
	await expect(grid.locator('.cell-editor')).toHaveCount(0);
	await expect(grid).toBeFocused();
});

test('a tap on the room around the editor of the cell being edited keeps the session', async ({
	page
}) => {
	const { cell, edits } = await start(page);
	const done = cell(1, 'done');
	await done.tap();
	const box = done.getByRole('checkbox');
	await expect(box).toBeFocused();
	// Mark this editor element: a restarted session would mount a new one.
	await box.evaluate((el) => el.setAttribute('data-first-session', ''));

	// Far from the compact checkbox at the cell's start: the cell itself.
	const size = (await done.boundingBox())!;
	const room = { x: size.width - 12, y: size.height / 2 };
	expect(
		await done.evaluate((el, at) => {
			const rect = el.getBoundingClientRect();
			return document.elementFromPoint(rect.left + at.x, rect.top + at.y) === el;
		}, room)
	).toBe(true);
	await done.tap({ position: room });
	await done.tap({ position: room });

	await expect(box).toBeFocused();
	await expect(box).toHaveAttribute('data-first-session', '');
	await expect(edits).toHaveText('0');
	await expect(done).toHaveAttribute('aria-busy', 'false');
});

test('a click no pointer made is not the tap of a press left behind', async ({ page }) => {
	const { grid, cell } = await start(page);
	const name = cell(2, 'name');
	// A press that never got its click or its end (a stale record).
	await name.evaluate((el) => {
		el.dispatchEvent(
			new PointerEvent('pointerdown', {
				bubbles: true,
				button: 0,
				pointerId: 9,
				pointerType: 'pen'
			})
		);
		// `element.click()`: a PointerEvent click with pointerId -1, as a keyboard
		// or assistive technology produces.
		(el as HTMLElement).click();
	});
	await expect(grid.locator('.cell-editor')).toHaveCount(0);
	await expect(name).not.toHaveClass(/active/);
});

test('a touch pan over the cells neither saves the open editor nor moves the active cell', async ({
	page
}) => {
	const { grid, cell, edits } = await start(page);
	await cell(0, 'name').tap();
	const editor = cell(0, 'name').getByRole('textbox');
	await editor.fill('Draft');

	const from = (await cell(5, 'note').boundingBox())!;
	const x = from.x + from.width / 2;
	const y = from.y + from.height / 2;
	const scrollBefore = await grid.evaluate((el) => el.scrollTop);
	const session = await page.context().newCDPSession(page);
	await session.send('Input.dispatchTouchEvent', {
		type: 'touchStart',
		touchPoints: [{ x, y, id: 1 }]
	});
	for (let step = 1; step <= 8; step += 1) {
		await session.send('Input.dispatchTouchEvent', {
			type: 'touchMove',
			touchPoints: [{ x, y: y - step * 12, id: 1 }]
		});
	}
	await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });

	// The pan really scrolled (otherwise this test proves nothing).
	await expect.poll(() => grid.evaluate((el) => el.scrollTop)).toBeGreaterThan(scrollBefore);
	await expect(edits).toHaveText('0');
	await expect(editor).toHaveValue('Draft');
	await expect(editor).toBeFocused();
	await expect(cell(0, 'name')).toHaveClass(/active/);
});
