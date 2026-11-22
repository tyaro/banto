/**
 * BantoForm file type (#714, plan §4.12) on the /ui-demo file card, in a real
 * browser: for a new record the chosen files wait on screen and are not part
 * of the submitted values; after the create they are uploaded, a file the
 * store refuses stays with the reason and can be taken off; in the edit state
 * a chosen file goes up at once and a delete is immediate after the
 * confirmation. The card's "store" is a local array (no backend). The
 * decisions themselves are unit-tested in packages/forms.
 * Runs against `vite dev` with VITE_BANTO_DEMO=1 (the `demo` project).
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import { primeThemeAndAuth } from '../visual/theme';

// Cold dev server: first compile / dep optimisation can reload the page.
test.setTimeout(120_000);

test.beforeEach(async ({ page }) => {
	await primeThemeAndAuth(page, { theme: 'light', preset: 'standard' });
});

function textFile(name: string, size = 16) {
	return { name, mimeType: 'text/plain', buffer: Buffer.alloc(size, 'a') };
}

async function openFileCard(page: Page) {
	await page.goto('/ui-demo');
	const card = page.getByTestId('ui-demo-file');
	const group = card.getByRole('group', { name: '資料' });
	// Hydrated: a record that does not exist has no files.
	await expect(group.getByText('ファイルはありません')).toBeVisible({ timeout: 60_000 });
	await card.scrollIntoViewIfNeeded();
	return { card, group, input: card.locator('[data-file-input]') };
}

const rows = (group: Locator) =>
	group.getByRole('list', { name: '資料のファイル' }).getByRole('listitem');

test('new: chosen files wait, are not submitted, and go up after the create', async ({ page }) => {
	const { card, group, input } = await openFileCard(page);
	await input.setInputFiles([textFile('a.txt'), textFile('big.txt', 70 * 1024)]);
	await expect(rows(group)).toHaveCount(2);
	await expect(rows(group).first()).toHaveAttribute('data-file-state', 'pending');
	await expect(group.getByText('選んだファイルは、保存のあとでアップロードされます')).toBeVisible();
	await expect(page.getByTestId('ui-demo-file-state')).toHaveText('新規（レコードはまだ無い）');

	await card.getByRole('textbox', { name: '件名' }).fill('memo');
	await card.getByRole('button', { name: '作成' }).click();
	// The record's values carry no file.
	await expect(page.getByTestId('ui-demo-file-values')).toHaveText('{"title":"memo"}');
	await expect(page.getByTestId('ui-demo-file-state')).toContainText('編集（レコード #1）');
	await expect(page.getByTestId('ui-demo-file-state')).toContainText(
		'アップロード 1 件、失敗 1 件'
	);

	// One arrived; the store refused the other (stricter than the field's 1 MB) and says why.
	await expect(rows(group).nth(0)).toHaveAttribute('data-file-state', 'existing');
	await expect(rows(group).nth(0)).toContainText('a.txt');
	const failed = rows(group).nth(1);
	await expect(failed).toHaveAttribute('data-file-state', 'failed');
	await expect(failed.getByRole('alert')).toHaveText('保存先の上限（64 KB）を超えています');
	await expect(failed.getByRole('button', { name: 'big.txt: 再試行' })).toBeVisible();

	// Taking the refused file off keeps the focus in the field.
	await failed.getByRole('button', { name: 'big.txt: 取り消す' }).click();
	await expect(rows(group)).toHaveCount(1);
	await expect(group.getByRole('button', { name: 'ファイルを選択' })).toBeFocused();
});

test('the field refuses a kind it does not accept, on screen', async ({ page }) => {
	const { group, input } = await openFileCard(page);
	await input.setInputFiles([
		{ name: 'run.exe', mimeType: 'application/octet-stream', buffer: Buffer.alloc(8) }
	]);
	await expect(group.getByRole('alert')).toHaveText(
		'run.exe: この種類のファイルは選べません（.txt,.pdf,image/*）'
	);
	await expect(rows(group)).toHaveCount(0);
});

test('edit: a chosen file goes up at once; a delete asks first', async ({ page }) => {
	const { card, group, input } = await openFileCard(page);
	await card.getByRole('button', { name: '作成' }).click();
	await expect(page.getByTestId('ui-demo-file-state')).toContainText('編集（レコード #1）');
	await expect(group.getByText('ファイルはありません')).toBeVisible();

	await input.setInputFiles([textFile('b.txt')]);
	await expect(rows(group)).toHaveCount(1);
	await expect(rows(group).first()).toHaveAttribute('data-file-state', 'existing');

	await group.getByRole('button', { name: 'b.txt: 削除' }).click();
	const dialog = page.getByRole('alertdialog', { name: '「b.txt」を削除しますか？' });
	await expect(dialog).toBeVisible();
	await dialog.getByRole('button', { name: 'OK' }).click();
	await expect(group.getByText('ファイルはありません')).toBeVisible();
});
