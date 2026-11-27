// @vitest-environment jsdom
/**
 * #1016, found with NVDA: a focus inside a `role="toolbar"` takes NVDA out of
 * browse mode, so the arrow keys reach the header row's roving tabindex; and a
 * sort changed in focus mode says nothing unless the live region reads it.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import BantoGrid from '../src/BantoGrid.svelte';
import type { GridColumn } from '../src/types';
import type { GridMessages } from '../src/messages';

beforeAll(() => {
	globalThis.ResizeObserver = class {
		observe() {}
		unobserve() {}
		disconnect() {}
	};
	Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
		configurable: true,
		get: () => 400
	});
	Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
		configurable: true,
		get: () => 32
	});
});
afterEach(cleanup);

interface Row {
	id: number;
	name: string;
	category: string;
}

const columns: GridColumn<Row>[] = [
	{ id: 'name', header: 'Name', accessor: 'name', filterable: true },
	{ id: 'category', header: 'Category', accessor: 'category' },
	{ id: 'plain', header: 'Plain', accessor: 'category', sortable: false }
];
const rows: Row[] = [
	{ id: 1, name: 'Beta', category: 'B' },
	{ id: 2, name: 'Alpha', category: 'A' }
];

function setup(props: { selectable?: boolean; messages?: Partial<GridMessages> } = {}) {
	return render(BantoGrid<Row>, {
		rows,
		columns,
		getRowId: (row: Row) => row.id,
		selectable: props.selectable ?? true,
		messages: props.messages
	});
}

function stops(container: HTMLElement) {
	return [...container.querySelectorAll<HTMLElement>('.header-row [data-banto-grid-header-stop]')];
}

/** The sort button of a column (its filter button has a name of its own, which also starts with the header). */
function sortButton(header: string) {
	return screen
		.getAllByRole('button')
		.find((el) => el.classList.contains('cell-body') && el.textContent?.trim().startsWith(header))!;
}

function key(target: Element, init: KeyboardEventInit) {
	const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
	target.dispatchEvent(event);
	return event;
}

describe('header controls sit in a role=toolbar', () => {
	it('wraps the select-all box, each sort button and each filter button; the resize separator stays outside', () => {
		const { container } = setup();
		for (const el of stops(container)) {
			const toolbar = el.closest('[role="toolbar"]');
			expect(toolbar, el.getAttribute('aria-label') ?? el.textContent ?? '').not.toBeNull();
			// Inside the header cell, not around the grid.
			expect(toolbar!.parentElement!.getAttribute('role')).toBe('columnheader');
		}
		for (const sep of container.querySelectorAll('.header-row [role="separator"]')) {
			expect(sep.closest('[role="toolbar"]')).toBeNull();
		}
		// Sort and filter of one column share a toolbar.
		const [, nameSort, nameFilter] = stops(container);
		expect(nameSort.closest('[role="toolbar"]')).toBe(nameFilter.closest('[role="toolbar"]'));
	});

	it('has no accessible name of its own, and the columnheader keeps its name and aria-sort', () => {
		const { container } = setup();
		for (const toolbar of container.querySelectorAll('.header-row [role="toolbar"]')) {
			expect(toolbar.hasAttribute('aria-label')).toBe(false);
			expect(toolbar.hasAttribute('aria-labelledby')).toBe(false);
		}
		const header = screen.getByRole('columnheader', { name: 'Name' });
		expect(header.getAttribute('aria-sort')).toBe('none');
	});

	it('keeps the roving tabindex across the toolbars', () => {
		const { container } = setup();
		const list = stops(container);
		expect(list.map((el) => el.getAttribute('tabindex'))).toEqual(['0', '-1', '-1', '-1']);
		list[0].focus();
		key(list[0], { key: 'ArrowRight' });
		expect(document.activeElement).toBe(list[1]);
		key(list[1], { key: 'End' });
		expect(document.activeElement).toBe(list[3]);
		expect(list.map((el) => el.getAttribute('tabindex'))).toEqual(['-1', '-1', '-1', '0']);
	});
});

describe('the sort is read out', () => {
	const status = () => screen.getByRole('status').textContent;

	it('says nothing at mount, then ascending, descending and cleared on Enter', async () => {
		setup();
		expect(status()).toBe('');
		await fireEvent.keyDown(sortButton('Name'), { key: 'Enter' });
		expect(status()).toBe('Nameで昇順に並べ替え');
		await fireEvent.keyDown(sortButton('Name'), { key: ' ' });
		expect(status()).toBe('Nameで降順に並べ替え');
		await fireEvent.keyDown(sortButton('Name'), { key: 'Enter' });
		expect(status()).toBe('並べ替えを解除');
	});

	it('is read for a mouse click too, and the region exists without row selection', async () => {
		setup({ selectable: false });
		const button = sortButton('Category');
		await fireEvent.pointerDown(button, { button: 0, pointerId: 1 });
		await fireEvent.pointerUp(window, { pointerId: 1 });
		expect(status()).toBe('Categoryで昇順に並べ替え');
	});

	it('names the position of a second key (Shift) and the key that was dropped', async () => {
		setup();
		await fireEvent.keyDown(sortButton('Name'), { key: 'Enter' });
		await fireEvent.keyDown(sortButton('Category'), {
			key: 'Enter',
			shiftKey: true
		});
		expect(status()).toBe('Categoryを第2キーで昇順に並べ替え');
		await fireEvent.keyDown(sortButton('Category'), {
			key: 'Enter',
			shiftKey: true
		});
		expect(status()).toBe('Categoryを第2キーで降順に並べ替え');
		await fireEvent.keyDown(sortButton('Category'), {
			key: 'Enter',
			shiftKey: true
		});
		expect(status()).toBe('Categoryを並べ替えから外しました');
	});

	it('uses the messages the host passes', async () => {
		setup({
			messages: {
				sortAscendingStatus: (header) => `asc ${header}`,
				sortClearedStatus: () => 'cleared'
			}
		});
		await fireEvent.keyDown(sortButton('Name'), { key: 'Enter' });
		expect(status()).toBe('asc Name');
	});
});
