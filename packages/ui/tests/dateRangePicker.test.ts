// @vitest-environment jsdom
/**
 * DateRangePicker (Issue #910): the boxes are DateRangeInput's (a named
 * group, 開始日 / 終了日, typed per end), the range is picked in ONE
 * calendar - the first pick the start, the second the end, swapped when the
 * second is earlier - with a preview up to the hovered / focused day, the
 * range `aria-selected` in an `aria-multiselectable` grid, a status line,
 * Esc dropping a half-picked range, and the §5.8 promises for the group.
 * jsdom has no Popover API: the stand-in from dateInput.test.ts is installed.
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/svelte';
import { flushSync } from 'svelte';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import DateRangePickerHarness from './fixtures/DateRangePickerHarness.svelte';

type PopoverElement = HTMLElement & { showPopover(): void; hidePopover(): void };

beforeAll(() => {
	const proto = HTMLElement.prototype as unknown as PopoverElement;
	proto.showPopover = function (this: HTMLElement) {
		this.dataset.popoverOpen = 'true';
		this.style.display = 'block';
	};
	proto.hidePopover = function (this: HTMLElement) {
		delete this.dataset.popoverOpen;
		this.style.removeProperty('display');
	};
});
afterEach(cleanup);

function setup(props: Record<string, unknown> = {}) {
	const handlers = {
		onValueChange: vi.fn(),
		onTextInput: vi.fn(),
		onkeydown: vi.fn(),
		onblur: vi.fn(),
		onHostKeydown: vi.fn(),
		onHostPointerdown: vi.fn()
	};
	const { rerender } = render(DateRangePickerHarness, { label: 'Visit', ...handlers, ...props });
	const group = screen.getByRole('group', { name: 'Visit' });
	const from = within(group).getByRole('textbox', { name: '開始日' }) as HTMLInputElement;
	const to = within(group).getByRole('textbox', { name: '終了日' }) as HTMLInputElement;
	const button = within(group).getByRole('button');
	return { ...handlers, group, from, to, button, rerender };
}

const dialog = () => screen.queryByRole('dialog', { name: '期間の選択' });
const cell = (date: string) => document.querySelector<HTMLElement>(`td[data-date="${date}"]`)!;
const focusedDate = () => (document.activeElement as HTMLElement | null)?.dataset.date;
const shown = () => screen.getByTestId('value').textContent;
const status = () => dialog()!.querySelector('[aria-live="polite"]:not(h2)')!.textContent?.trim();
const selected = () =>
	[...document.querySelectorAll<HTMLElement>('td[aria-selected="true"]')].map(
		(td) => td.dataset.date
	);
const classed = (name: string) =>
	[...document.querySelectorAll<HTMLElement>(`td.${name}`)].map((td) => td.dataset.date);

function key(name: string, init: KeyboardEventInit = {}) {
	fireEvent.keyDown(document.activeElement!, { key: name, ...init });
	flushSync();
}

describe('DateRangePicker boxes', () => {
	it('is a named group of the two named boxes and one calendar button', () => {
		const { from, to, button } = setup({ value: { from: '2026-11-10', to: '2026-11-14' } });
		expect(from.value).toBe('2026-11-10');
		expect(to.value).toBe('2026-11-14');
		expect(button.getAttribute('aria-label')).toBe(
			'期間を変更、2026年11月10日火曜日～2026年11月14日土曜日'
		);
		const hintId = from.getAttribute('aria-describedby')!;
		expect(to.getAttribute('aria-describedby')).toBe(hintId);
		expect(document.getElementById(hintId)?.textContent).toBe(
			'YYYY-MM-DD の形で入力（例: 2026-11-07）'
		);
	});

	it('takes its name from labelledBy; says "choose" without both ends', () => {
		const { button } = setup({ label: 'Ignored', labelledBy: 'range-name' });
		expect(screen.getByRole('group', { name: 'Visit' })).toBeTruthy();
		expect(button.getAttribute('aria-label')).toBe('期間を選択');
	});

	it('commits each box on Enter / blur and reports text per end (order not checked)', async () => {
		const { from, to, onValueChange, onTextInput } = setup();
		await fireEvent.input(from, { target: { value: '2026/12/1' } });
		expect(onTextInput).toHaveBeenLastCalledWith('from', '2026/12/1');
		await fireEvent.keyDown(from, { key: 'Enter' });
		expect(from.value).toBe('2026-12-01');
		expect(onValueChange).toHaveBeenLastCalledWith({ from: '2026-12-01', to: null });
		await fireEvent.input(to, { target: { value: '11/1' } });
		to.focus();
		from.focus();
		flushSync();
		expect(to.value).toMatch(/^\d{4}-11-01$/);
		expect(onValueChange).toHaveBeenCalledTimes(2);
		// Text that does not parse is left alone.
		await fireEvent.input(from, { target: { value: 'abc' } });
		await fireEvent.keyDown(from, { key: 'Enter' });
		expect(from.value).toBe('abc');
		expect(onValueChange).toHaveBeenCalledTimes(2);
	});

	it('Enter while composing does not commit', async () => {
		const { from, onValueChange } = setup();
		await fireEvent.input(from, { target: { value: '2026/12/1' } });
		await fireEvent.keyDown(from, { key: 'Enter', keyCode: 229, isComposing: true });
		expect(onValueChange).not.toHaveBeenCalled();
	});
});

describe('DateRangePicker calendar', () => {
	it('opens on the start with two months, the range selected in a multiselectable grid', () => {
		const { button } = setup({ value: { from: '2026-11-28', to: '2026-12-02' } });
		fireEvent.click(button);
		expect(dialog()?.dataset.popoverOpen).toBe('true');
		const grids = screen.getAllByRole('grid');
		expect(grids).toHaveLength(2);
		expect(grids[0].getAttribute('aria-multiselectable')).toBe('true');
		expect(focusedDate()).toBe('2026-11-28');
		expect(selected()).toEqual([
			'2026-11-28',
			'2026-11-29',
			'2026-11-30',
			'2026-12-01',
			'2026-12-02'
		]);
		expect(classed('date-picker-day--range-start')).toEqual(['2026-11-28']);
		expect(classed('date-picker-day--range-end')).toEqual(['2026-12-02']);
		expect(status()).toBe('開始日を選んでください');
	});

	it('first click is the start, a hover previews, the second click sets the range', () => {
		const { button, from, to, onValueChange } = setup();
		fireEvent.click(button);
		fireEvent.click(cell('2026-11-10'));
		flushSync();
		expect(onValueChange).not.toHaveBeenCalled();
		expect(selected()).toEqual(['2026-11-10']);
		expect(status()).toBe('開始日 2026年11月10日火曜日。終了日を選んでください');
		fireEvent.mouseEnter(cell('2026-11-13'));
		flushSync();
		expect(classed('date-picker-day--preview')).toEqual([
			'2026-11-10',
			'2026-11-11',
			'2026-11-12',
			'2026-11-13'
		]);
		// Only the start is selected while the end is a preview.
		expect(selected()).toEqual(['2026-11-10']);
		fireEvent.click(cell('2026-12-03'));
		flushSync();
		expect(onValueChange).toHaveBeenLastCalledWith({ from: '2026-11-10', to: '2026-12-03' });
		expect(from.value).toBe('2026-11-10');
		expect(to.value).toBe('2026-12-03');
		expect(shown()).toBe('2026-11-10..2026-12-03');
		expect(dialog()).toBeNull();
		expect(document.activeElement).toBe(from);
	});
});

describe('DateRangePicker calendar (keys and edges)', () => {
	it('a second pick before the start swaps the ends', () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(new Date(2026, 10, 20, 10, 0));
		try {
			const { button, onValueChange } = setup();
			fireEvent.click(button);
			expect(focusedDate()).toBe('2026-11-20');
			fireEvent.click(cell('2026-11-20'));
			fireEvent.click(cell('2026-11-05'));
			expect(onValueChange).toHaveBeenLastCalledWith({ from: '2026-11-05', to: '2026-11-20' });
		} finally {
			vi.useRealTimers();
		}
	});

	it('Enter sets the start, the arrows preview, Enter again sets the end', () => {
		const { button, onValueChange } = setup({ value: { from: '2026-11-10', to: null } });
		fireEvent.click(button);
		expect(selected()).toEqual(['2026-11-10']);
		key('Enter');
		key('ArrowDown');
		key('ArrowRight');
		expect(focusedDate()).toBe('2026-11-18');
		expect(classed('date-picker-day--range-end')).toEqual(['2026-11-18']);
		key('Enter');
		expect(onValueChange).toHaveBeenLastCalledWith({ from: '2026-11-10', to: '2026-11-18' });
	});

	it('Esc drops a half-picked range and returns focus to the box it opened from', () => {
		const { to, onValueChange } = setup({ value: { from: '2026-11-10', to: '2026-11-12' } });
		to.focus();
		fireEvent.keyDown(to, { key: 'ArrowDown', altKey: true });
		flushSync();
		expect(dialog()).not.toBeNull();
		key('Enter');
		key('ArrowRight');
		// Esc while composing is the IME's.
		key('Escape', { keyCode: 229, isComposing: true });
		expect(dialog()).not.toBeNull();
		key('Escape');
		expect(dialog()).toBeNull();
		expect(document.activeElement).toBe(to);
		expect(onValueChange).not.toHaveBeenCalled();
		fireEvent.keyDown(to, { key: 'ArrowDown', altKey: true });
		flushSync();
		expect(selected()).toEqual(['2026-11-10', '2026-11-11', '2026-11-12']);
	});

	it('an end cannot be a disabled day or outside min / max', () => {
		const { button, onValueChange } = setup({
			value: { from: null, to: null },
			min: '2026-11-02',
			max: '2026-11-27',
			isDateDisabled: (d: string) => d === '2026-11-14'
		});
		fireEvent.click(button);
		fireEvent.click(cell('2026-11-14'));
		fireEvent.click(cell('2026-11-01'));
		fireEvent.click(cell('2026-11-10'));
		fireEvent.click(cell('2026-11-14'));
		expect(onValueChange).not.toHaveBeenCalled();
		// The days between may be disabled.
		fireEvent.click(cell('2026-11-16'));
		expect(onValueChange).toHaveBeenLastCalledWith({ from: '2026-11-10', to: '2026-11-16' });
	});

	it('Clear empties both ends', () => {
		const { button, from, to, onValueChange } = setup({
			value: { from: '2026-11-10', to: '2026-11-12' }
		});
		fireEvent.click(button);
		fireEvent.click(screen.getByRole('button', { name: 'クリア' }));
		expect(onValueChange).toHaveBeenLastCalledWith({ from: null, to: null });
		expect(from.value).toBe('');
		expect(to.value).toBe('');
	});

	it('keeps keys and pointerdown inside; onblur only when focus leaves the group', () => {
		const { from, to, button, onHostKeydown, onHostPointerdown, onblur } = setup({
			value: { from: '2026-11-10', to: '2026-11-12' }
		});
		from.focus();
		to.focus();
		flushSync();
		expect(onblur).not.toHaveBeenCalled();
		fireEvent.click(button);
		onHostKeydown.mockClear();
		key('ArrowLeft');
		expect(onHostKeydown).not.toHaveBeenCalled();
		fireEvent.pointerDown(cell('2026-11-05'));
		expect(onHostPointerdown).not.toHaveBeenCalled();
		const outside = screen.getByRole('button', { name: 'Outside' });
		fireEvent.pointerDown(outside);
		outside.focus();
		flushSync();
		expect(dialog()).toBeNull();
		expect(onblur).toHaveBeenCalledTimes(1);
	});
});

describe('DateRangePicker mixed pointer and keyboard (PR #912 review)', () => {
	it('after a click and a hover, the arrow keys move the preview to the focused day', () => {
		const { button, onValueChange } = setup();
		fireEvent.click(button);
		fireEvent.mouseEnter(cell('2026-11-10'));
		fireEvent.click(cell('2026-11-10'));
		flushSync();
		// The pointer rests on the start; the keys take over.
		key('ArrowRight');
		key('ArrowRight');
		expect(focusedDate()).toBe('2026-11-12');
		expect(classed('date-picker-day--range-end')).toEqual(['2026-11-12']);
		key('Enter');
		expect(onValueChange).toHaveBeenLastCalledWith({ from: '2026-11-10', to: '2026-11-12' });
	});

	it('a start that the new bounds rule out is replaced by the next pick', async () => {
		const { button, rerender, onValueChange } = setup();
		fireEvent.click(button);
		fireEvent.click(cell('2026-11-03'));
		await rerender({ min: '2026-11-05' });
		fireEvent.click(cell('2026-11-10'));
		expect(onValueChange).not.toHaveBeenCalled();
		expect(selected()).toEqual(['2026-11-10']);
		fireEvent.click(cell('2026-11-12'));
		expect(onValueChange).toHaveBeenLastCalledWith({ from: '2026-11-10', to: '2026-11-12' });
	});

	it('made disabled while open: closes without a change', async () => {
		const { button, rerender, onValueChange } = setup({
			value: { from: '2026-11-10', to: '2026-11-12' }
		});
		fireEvent.click(button);
		fireEvent.click(cell('2026-11-14'));
		await rerender({ disabled: true });
		expect(dialog()).toBeNull();
		expect(onValueChange).not.toHaveBeenCalled();
	});
});

describe('DateRangePicker day names (Issue #997)', () => {
	const name = (date: string) => cell(date).getAttribute('aria-label');

	it('names the start and the end day, and nothing else', () => {
		const { button } = setup({ value: { from: '2026-11-10', to: '2026-11-12' } });
		fireEvent.click(button);
		expect(name('2026-11-10')).toBe('2026年11月10日火曜日、開始日');
		expect(name('2026-11-11')).toBe('2026年11月11日水曜日');
		expect(name('2026-11-12')).toBe('2026年11月12日木曜日、終了日');
		expect(name('2026-11-13')).toBe('2026年11月13日金曜日');
	});

	it('names a one-day range once, as both', () => {
		const { button } = setup({ value: { from: '2026-11-10', to: '2026-11-10' } });
		fireEvent.click(button);
		expect(name('2026-11-10')).toBe('2026年11月10日火曜日、開始日・終了日');
	});

	it('names a one-ended value as the end it is', () => {
		const first = setup({ value: { from: '2026-11-10', to: null } });
		fireEvent.click(first.button);
		expect(name('2026-11-10')).toBe('2026年11月10日火曜日、開始日');
		cleanup();
		const second = setup({ value: { from: null, to: '2026-11-12' } });
		fireEvent.click(second.button);
		expect(name('2026-11-12')).toBe('2026年11月12日木曜日、終了日');
	});

	it('while the end is a preview, only the anchor is the start', () => {
		const { button } = setup();
		fireEvent.click(button);
		fireEvent.click(cell('2026-11-10'));
		fireEvent.mouseEnter(cell('2026-11-13'));
		flushSync();
		expect(name('2026-11-10')).toBe('2026年11月10日火曜日、開始日');
		expect(name('2026-11-13')).toBe('2026年11月13日金曜日');
		expect(name('2026-11-11')).toBe('2026年11月11日水曜日');
		// Previewing backwards: the anchor is still the start, the hovered day is not named.
		fireEvent.mouseEnter(cell('2026-11-08'));
		flushSync();
		expect(name('2026-11-10')).toBe('2026年11月10日火曜日、開始日');
		expect(name('2026-11-08')).toBe('2026年11月8日日曜日');
	});
});
