// @vitest-environment jsdom
/**
 * #1069: `rowTone` marks a data row with `data-row-tone` (the ground is drawn
 * by the component's CSS from the theme's tint tokens - the colours and their
 * contrast are covered in row-tone-contrast.test.ts, the look in
 * e2e/visual/grid-row-tone.spec.ts). Here: the attribute lands on the right
 * row, also after a sort / a filter, next to `rowClass`, the row selection,
 * the active cell and the pinned cells, and nothing else changes (no ARIA).
 * Same jsdom stubs as BantoGrid.test.ts so rows virtualize into view.
 */
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { tick } from 'svelte';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import BantoGrid from '../src/BantoGrid.svelte';
import { GridState } from '../src/state.svelte';
import type { CellTone, GridColumn } from '../src/types';

beforeAll(() => {
	globalThis.ResizeObserver = class {
		observe() {}
		unobserve() {}
		disconnect() {}
	};
	Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
		configurable: true,
		get() {
			return 400;
		}
	});
	Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
		configurable: true,
		get() {
			return 600;
		}
	});
	Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
		configurable: true,
		get() {
			return 32;
		}
	});
});

afterEach(cleanup);

interface Alarm {
	id: number;
	name: string;
	level: 'fault' | 'check' | 'ok' | 'note';
	count: number;
}

const rows: Alarm[] = [
	{ id: 1, name: 'ポンプ', level: 'fault', count: 3 },
	{ id: 2, name: 'バルブ', level: 'check', count: 1 },
	{ id: 3, name: 'タンク', level: 'ok', count: 2 },
	{ id: 4, name: 'ヒーター', level: 'note', count: 5 }
];

const columns: GridColumn<Alarm>[] = [
	{ id: 'name', header: '設備', accessor: 'name', width: 120, pinned: 'left' },
	{ id: 'level', header: '状態', accessor: 'level', width: 120 },
	{ id: 'count', header: '回数', accessor: 'count', width: 120 }
];

const getRowId = (row: Alarm) => row.id;

/** `ok` rows are left alone: `undefined` paints nothing. */
const rowTone = (row: Alarm): CellTone | undefined =>
	row.level === 'fault'
		? 'danger'
		: row.level === 'check'
			? 'warning'
			: row.level === 'note'
				? 'info'
				: undefined;

function dataRows(container: HTMLElement): HTMLElement[] {
	return [...container.querySelectorAll<HTMLElement>('.row')].filter((row) =>
		row.querySelector('[data-cell-row]')
	);
}

/** `[name, tone]` of each drawn data row, in the drawn order. */
function tones(container: HTMLElement): [string, string | null][] {
	return dataRows(container).map((row) => [
		row.querySelector('[data-cell-field="name"]')!.textContent!.trim(),
		row.getAttribute('data-row-tone')
	]);
}

function rowOf(container: HTMLElement, name: string): HTMLElement {
	return dataRows(container).find(
		(row) => row.querySelector('[data-cell-field="name"]')!.textContent!.trim() === name
	)!;
}

describe('BantoGrid rowTone (#1069)', () => {
	it('adds no attribute without rowTone', () => {
		const { container } = render(BantoGrid<Alarm>, { rows, columns, getRowId });
		expect(dataRows(container)).toHaveLength(4);
		expect(container.querySelector('[data-row-tone]')).toBeNull();
	});

	it('marks each row with its tone, and leaves a row alone for undefined', () => {
		const { container } = render(BantoGrid<Alarm>, { rows, columns, getRowId, rowTone });
		expect(tones(container)).toEqual([
			['ポンプ', 'danger'],
			['バルブ', 'warning'],
			['タンク', null],
			['ヒーター', 'info']
		]);
		expect(rowOf(container, 'タンク').hasAttribute('data-row-tone')).toBe(false);
	});

	it('accepts every CellTone', () => {
		const all: CellTone[] = ['success', 'warning', 'danger', 'info', 'neutral'];
		const { container } = render(BantoGrid<Alarm>, {
			rows: all.map((_, i) => ({ id: i, name: `行${i}`, level: 'ok' as const, count: i })),
			columns,
			getRowId,
			rowTone: (row) => all[row.id]
		});
		expect(tones(container).map(([, tone]) => tone)).toEqual(all);
	});

	it('works together with rowClass', () => {
		const { container } = render(BantoGrid<Alarm>, {
			rows,
			columns,
			getRowId,
			rowTone,
			rowClass: (row) => (row.count >= 3 ? 'frequent' : undefined)
		});
		const pump = rowOf(container, 'ポンプ');
		expect(pump.classList.contains('frequent')).toBe(true);
		expect(pump.getAttribute('data-row-tone')).toBe('danger');
		// rowClass alone, rowTone alone
		const heater = rowOf(container, 'ヒーター');
		expect(heater.classList.contains('frequent')).toBe(true);
		expect(heater.getAttribute('data-row-tone')).toBe('info');
		const valve = rowOf(container, 'バルブ');
		expect(valve.classList.contains('frequent')).toBe(false);
		expect(valve.getAttribute('data-row-tone')).toBe('warning');
		const tank = rowOf(container, 'タンク');
		expect(tank.classList.contains('frequent')).toBe(false);
		expect(tank.hasAttribute('data-row-tone')).toBe(false);
	});

	it('follows the rows through a sort', async () => {
		const state = new GridState(columns);
		const { container } = render(BantoGrid<Alarm>, { rows, columns, getRowId, rowTone, state });
		state.toggleSort('count', false);
		await tick();
		expect(tones(container)).toEqual([
			['バルブ', 'warning'],
			['タンク', null],
			['ポンプ', 'danger'],
			['ヒーター', 'info']
		]);
		state.toggleSort('count', false);
		await tick();
		expect(tones(container)).toEqual([
			['ヒーター', 'info'],
			['ポンプ', 'danger'],
			['タンク', null],
			['バルブ', 'warning']
		]);
	});

	it('follows the rows through a filter', async () => {
		const state = new GridState(columns);
		const { container } = render(BantoGrid<Alarm>, { rows, columns, getRowId, rowTone, state });
		state.setFilter({ field: 'count', op: 'gte', value: 2 });
		await tick();
		expect(tones(container)).toEqual([
			['ポンプ', 'danger'],
			['タンク', null],
			['ヒーター', 'info']
		]);
		state.clearFilters();
		await tick();
		expect(tones(container)).toHaveLength(4);
		expect(rowOf(container, 'バルブ').getAttribute('data-row-tone')).toBe('warning');
	});

	it('follows a row whose data changes', async () => {
		const { container, rerender } = render(BantoGrid<Alarm>, { rows, columns, getRowId, rowTone });
		await rerender({
			rows: rows.map((row) => (row.id === 1 ? { ...row, level: 'ok' as const } : row))
		});
		expect(rowOf(container, 'ポンプ').hasAttribute('data-row-tone')).toBe(false);
		expect(rowOf(container, 'バルブ').getAttribute('data-row-tone')).toBe('warning');
	});

	it('keeps the selection, the active cell and the pinned cells on a toned row', async () => {
		const { container } = render(BantoGrid<Alarm>, {
			rows,
			columns,
			getRowId,
			rowTone,
			selectable: true,
			selectedRowIds: [1]
		});
		const pump = rowOf(container, 'ポンプ');
		// selected + toned: both marks are on the row (the CSS picks the band)
		expect(pump.classList.contains('selected')).toBe(true);
		expect(pump.getAttribute('data-row-tone')).toBe('danger');
		// the band is drawn on the checkbox cell, the row's first child
		expect(pump.firstElementChild!.classList.contains('select-cell')).toBe(true);
		// toned, not selected
		const valve = rowOf(container, 'バルブ');
		expect(valve.classList.contains('selected')).toBe(false);
		expect(valve.getAttribute('data-row-tone')).toBe('warning');
		// pinned cells stay pinned (their ground is layered in CSS)
		const pinned = valve.querySelector<HTMLElement>('[data-cell-field="name"]')!;
		expect(pinned.classList.contains('pinned')).toBe(true);
		expect(valve.querySelector('.select-cell')!.classList.contains('pinned')).toBe(true);
		// the active cell keeps its class on a toned row
		const cell = valve.querySelector<HTMLElement>('[data-cell-field="level"]')!;
		await fireEvent.pointerDown(cell, { button: 0 });
		await fireEvent.mouseDown(cell, { button: 0 });
		await fireEvent.click(cell);
		await tick();
		expect(
			rowOf(container, 'バルブ')
				.querySelector('[data-cell-field="level"]')!
				.classList.contains('active')
		).toBe(true);
		expect(rowOf(container, 'バルブ').getAttribute('data-row-tone')).toBe('warning');
	});

	it('changes no ARIA: the tone is looks only', () => {
		/** role + every aria-* attribute of every element, in document order. */
		const aria = (container: HTMLElement) =>
			[...container.querySelectorAll('*')].map((el) =>
				[...el.attributes]
					.filter((a) => a.name === 'role' || a.name.startsWith('aria-'))
					.map((a) => `${a.name}=${a.value}`)
					.join(' ')
			);
		const plain = render(BantoGrid<Alarm>, { rows, columns, getRowId });
		const before = aria(plain.container);
		cleanup();
		const toned = render(BantoGrid<Alarm>, { rows, columns, getRowId, rowTone });
		expect(toned.container.querySelectorAll('[data-row-tone]')).toHaveLength(3);
		expect(aria(toned.container)).toEqual(before);
	});

	it('does not mark group header rows', async () => {
		const state = new GridState(columns);
		state.groupBy = 'level';
		const { container } = render(BantoGrid<Alarm>, { rows, columns, getRowId, rowTone, state });
		await tick();
		const headers = [...container.querySelectorAll('.group-header-row')];
		expect(headers.length).toBeGreaterThan(0);
		for (const header of headers) expect(header.hasAttribute('data-row-tone')).toBe(false);
	});
});
