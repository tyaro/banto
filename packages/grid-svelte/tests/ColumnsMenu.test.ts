// @vitest-environment jsdom
/**
 * ColumnsMenu (spec §4.4 column manager) interaction test.
 *
 * Covers the three things the component owns on top of `GridState`: the
 * open/dismiss model (same Escape + outside-pointerdown contract as
 * FilterPopover - see that file's doc on why there is no focus trap), the
 * checkbox <-> `hidden` wiring, the last-visible-column lock that makes
 * `setColumnHidden`'s refusal visible instead of a dead click, and the pin
 * toggle <-> `pinned` wiring (#713).
 *
 * Outside/inside pointer-down cases dispatch a plain `Event('pointerdown')`
 * (jsdom provides no `PointerEvent` constructor); the component only reads
 * `event.target`, so a generic bubbling event exercises the same listener.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ColumnsMenu from '../src/ColumnsMenu.svelte';
import { GridState } from '../src/state.svelte';
import type { GridColumn } from '../src/types';

afterEach(cleanup);

interface Row {
	id: number;
	name: string;
	price: number;
}

const columns: GridColumn<Row>[] = [
	{ id: 'id', header: 'ID', accessor: 'id' },
	{ id: 'name', header: '商品名', accessor: 'name' },
	{ id: 'price', header: '価格', accessor: 'price' }
];

function renderMenu(state = new GridState<Row>(columns)) {
	render(ColumnsMenu<Row>, { state });
	return state;
}

function openMenu(): void {
	fireEvent.click(screen.getByRole('button', { name: /列/ }));
}

function pointerDown(target: EventTarget) {
	target.dispatchEvent(new Event('pointerdown', { bubbles: true }));
}

describe('ColumnsMenu', () => {
	it('opens a labelled dialog with one checkbox per column', async () => {
		const state = renderMenu();
		state.setColumnHidden('id', true);
		openMenu();

		expect(await screen.findByRole('dialog', { name: '列の表示' })).toBeTruthy();
		const boxes = screen.getAllByRole('checkbox') as HTMLInputElement[];
		expect(boxes).toHaveLength(3);
		// Hidden column reads as unchecked, visible ones as checked.
		expect(boxes.map((box) => box.checked)).toEqual([false, true, true]);
	});

	it('shows the visible/total count on the trigger', async () => {
		const state = renderMenu();
		expect(screen.getByRole('button', { name: /列/ }).textContent).toContain('3/3');

		state.setColumnHidden('id', true);
		expect((await screen.findByRole('button', { name: /列/ })).textContent).toContain('2/3');
	});

	it('unchecking a column hides it in the shared GridState', async () => {
		const state = renderMenu();
		openMenu();

		await fireEvent.click(screen.getByRole('checkbox', { name: '商品名' }));

		expect(state.isHidden('name')).toBe(true);
		expect(state.orderedColumns.map((column) => column.id)).toEqual(['id', 'price']);
	});

	it('re-checking a hidden column brings it back', async () => {
		const state = renderMenu();
		state.setColumnHidden('name', true);
		openMenu();

		await fireEvent.click(await screen.findByRole('checkbox', { name: '商品名' }));

		expect(state.isHidden('name')).toBe(false);
	});

	it('locks the last visible column instead of offering a dead click', async () => {
		const state = renderMenu();
		state.setColumnHidden('id', true);
		state.setColumnHidden('name', true);
		openMenu();

		const last = (await screen.findByRole('checkbox', { name: '価格' })) as HTMLInputElement;
		expect(last.disabled).toBe(true);
		expect(state.orderedColumns).toHaveLength(1);
	});

	it('closes on Escape', async () => {
		renderMenu();
		openMenu();
		expect(await screen.findByRole('dialog')).toBeTruthy();

		await fireEvent.keyDown(window, { key: 'Escape' });

		expect(screen.queryByRole('dialog')).toBeNull();
	});

	it('closes on a pointer-down outside, but not inside', async () => {
		renderMenu();
		openMenu();
		const dialog = await screen.findByRole('dialog');

		pointerDown(dialog);
		expect(screen.queryByRole('dialog')).not.toBeNull();

		pointerDown(document.body);
		await Promise.resolve();
		expect(screen.queryByRole('dialog')).toBeNull();
	});

	describe('pin toggle (#713)', () => {
		function pinButton(header: string): HTMLButtonElement {
			return screen.getByRole('button', { name: `${header}を左端に固定` }) as HTMLButtonElement;
		}

		it('offers one unpressed toggle per column', async () => {
			renderMenu();
			openMenu();
			await screen.findByRole('dialog');

			for (const header of ['ID', '商品名', '価格']) {
				expect(pinButton(header).getAttribute('aria-pressed')).toBe('false');
				expect(pinButton(header).title).toBe(`${header}を左端に固定`);
			}
		});

		it('pinning a column updates `pinned` and moves it to the front of orderedColumns', async () => {
			const state = renderMenu();
			openMenu();
			await screen.findByRole('dialog');

			await fireEvent.click(pinButton('価格'));

			expect(state.pinned).toEqual(['price']);
			expect(state.orderedColumns.map((column) => column.id)).toEqual(['price', 'id', 'name']);
			expect(state.pinnedCount).toBe(1);
			// Same name, pressed; the tooltip says what the next click does.
			expect(pinButton('価格').getAttribute('aria-pressed')).toBe('true');
			expect(pinButton('価格').title).toBe('価格の固定を解除');
			// The list follows `allColumns` (pinned first).
			const boxes = screen.getAllByRole('checkbox');
			expect(boxes.map((box) => box.closest('label')?.textContent?.trim())).toEqual([
				'価格',
				'ID',
				'商品名'
			]);
		});

		it('keeps focus on the toggle when its row moves', async () => {
			renderMenu();
			openMenu();
			await screen.findByRole('dialog');
			const button = pinButton('価格');
			button.focus();

			await fireEvent.click(button);

			await vi.waitFor(() => expect(document.activeElement).toBe(pinButton('価格')));
		});

		it('unpinning puts the column back in its slot', async () => {
			const state = renderMenu(
				new GridState<Row>(
					columns.map((column) => (column.id === 'price' ? { ...column, pinned: 'left' } : column))
				)
			);
			openMenu();
			await screen.findByRole('dialog');
			expect(pinButton('価格').getAttribute('aria-pressed')).toBe('true');

			await fireEvent.click(pinButton('価格'));

			expect(state.pinned).toEqual([]);
			expect(state.orderedColumns.map((column) => column.id)).toEqual(['id', 'name', 'price']);
			expect(pinButton('価格').getAttribute('aria-pressed')).toBe('false');
		});

		it('uses the injected messages', async () => {
			render(ColumnsMenu<Row>, {
				state: new GridState<Row>(columns),
				messages: {
					pinColumn: (header) => `Pin ${header} to the left`,
					unpinColumn: (header) => `Unpin ${header}`
				}
			});
			openMenu();
			await screen.findByRole('dialog');

			const button = screen.getByRole('button', { name: 'Pin ID to the left' });
			await fireEvent.click(button);

			const pressed = screen.getByRole('button', { name: 'Pin ID to the left' });
			expect(pressed.getAttribute('aria-pressed')).toBe('true');
			expect((pressed as HTMLButtonElement).title).toBe('Unpin ID');
		});
	});
});
