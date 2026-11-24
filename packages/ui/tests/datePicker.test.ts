// @vitest-environment jsdom
/**
 * DatePicker (Issue #910): DateInput's text box and keys with the extended
 * calendar - two months side by side (one with `months={1}` or on a narrow
 * screen), the neighbouring months' days as empty slots, focus moving past
 * the shown months scrolling them, each month's heading opening its own
 * month view, Esc going back one view and then closing. jsdom has no Popover
 * API: the stand-in from dateInput.test.ts is installed.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { flushSync } from 'svelte';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import DatePickerHarness from './fixtures/DatePickerHarness.svelte';

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

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

function setup(props: Record<string, unknown> = {}) {
	const handlers = {
		onValueChange: vi.fn(),
		onkeydown: vi.fn(),
		onblur: vi.fn(),
		onHostKeydown: vi.fn(),
		onHostPointerdown: vi.fn()
	};
	const { rerender } = render(DatePickerHarness, { ...handlers, ...props });
	const input = screen.getByRole('textbox', { name: 'Due date' }) as HTMLInputElement;
	const button = document.querySelector<HTMLButtonElement>('[aria-haspopup="dialog"]')!;
	return { ...handlers, input, button, rerender };
}

const dialog = () => screen.queryByRole('dialog', { name: '日付の選択' });
const cell = (date: string) => document.querySelector<HTMLElement>(`td[data-date="${date}"]`);
const focusedDate = () => (document.activeElement as HTMLElement | null)?.dataset.date;
const headings = () =>
	screen
		.getAllByRole('grid')
		.map((grid) =>
			document
				.getElementById(grid.getAttribute('aria-labelledby')!)!
				.textContent?.replace(/\s+/g, '')
		);

function key(name: string, init: KeyboardEventInit = {}) {
	fireEvent.keyDown(document.activeElement!, { key: name, ...init });
	flushSync();
}

describe('DatePicker', () => {
	it('opens two months side by side on the value, each grid named by its heading', () => {
		const { button, input } = setup({ value: '2026-11-07' });
		expect(button.getAttribute('aria-label')).toBe('日付を変更、2026年11月7日土曜日');
		expect(input.getAttribute('aria-describedby')).toBeTruthy();
		fireEvent.click(button);
		expect(dialog()?.dataset.popoverOpen).toBe('true');
		expect(headings()).toEqual(['2026年11月', '2026年12月']);
		expect(focusedDate()).toBe('2026-11-07');
		expect(cell('2026-11-07')?.getAttribute('aria-selected')).toBe('true');
		// The neighbouring months' days are empty slots: no day is shown twice.
		expect(document.querySelectorAll('td[data-date="2026-12-01"]')).toHaveLength(1);
		expect(cell('2026-10-31')).toBeNull();
		// The previous buttons sit before the first month, the next ones after the last.
		const names = [...dialog()!.querySelectorAll('button[aria-label]')].map((b) =>
			b.getAttribute('aria-label')
		);
		expect(names).toEqual(['前の年', '前の月', '次の月', '次の年']);
	});

	it('moves focus across the two months and scrolls them just far enough', () => {
		const { button } = setup({ value: '2026-11-30' });
		fireEvent.click(button);
		key('ArrowRight');
		expect(focusedDate()).toBe('2026-12-01');
		expect(headings()).toEqual(['2026年11月', '2026年12月']);
		key('PageDown');
		expect(focusedDate()).toBe('2027-01-01');
		expect(headings()).toEqual(['2026年12月', '2027年1月']);
		key('PageUp');
		key('PageUp');
		expect(focusedDate()).toBe('2026-11-01');
		expect(headings()).toEqual(['2026年11月', '2026年12月']);
		// Focus never left the dialog while the months scrolled.
		expect(dialog()!.contains(document.activeElement)).toBe(true);
	});

	it('Enter picks the focused day, sets the value and returns focus to the box', () => {
		const { button, input, onValueChange } = setup({ value: '2026-11-07' });
		fireEvent.click(button);
		key('ArrowDown');
		key('Enter');
		expect(onValueChange).toHaveBeenLastCalledWith('2026-11-14');
		expect(input.value).toBe('2026-11-14');
		expect(dialog()).toBeNull();
		expect(document.activeElement).toBe(input);
	});

	it('a click on a day of the second month picks it', () => {
		const { button, onValueChange } = setup({ value: '2026-11-07' });
		fireEvent.click(button);
		fireEvent.click(cell('2026-12-24')!);
		expect(onValueChange).toHaveBeenLastCalledWith('2026-12-24');
	});

	it("the second month's heading opens its own month view; Esc goes back, then closes", () => {
		const { button, input } = setup({ value: '2026-11-07' });
		fireEvent.click(button);
		const monthButtons = screen.getAllByRole('button', { name: /月$/ });
		const december = monthButtons.find((b) => b.textContent?.trim() === '12月')!;
		fireEvent.click(december);
		flushSync();
		const focused = document.activeElement as HTMLElement;
		expect(focused.getAttribute('aria-label')).toBe('2026年12月');
		key('Escape');
		expect(dialog()).not.toBeNull();
		expect(screen.getAllByRole('grid')).toHaveLength(2);
		key('Escape');
		expect(dialog()).toBeNull();
		expect(document.activeElement).toBe(input);
	});

	it('picking a month in the month view shows it first', () => {
		const { button } = setup({ value: '2026-11-07' });
		fireEvent.click(button);
		fireEvent.click(screen.getByRole('button', { name: '11月' }));
		flushSync();
		key('ArrowRight');
		key('ArrowRight');
		key('ArrowRight');
		key('Enter');
		expect(headings()).toEqual(['2027年2月', '2027年3月']);
		expect(focusedDate()).toBe('2027-02-07');
	});

	it('Today and Clear set the value and close', () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(new Date(2026, 10, 10, 10, 0));
		try {
			const { button, onValueChange } = setup({ value: '2026-11-07' });
			fireEvent.click(button);
			fireEvent.click(screen.getByRole('button', { name: '今日' }));
			expect(onValueChange).toHaveBeenLastCalledWith('2026-11-10');
			fireEvent.click(button);
			fireEvent.click(screen.getByRole('button', { name: 'クリア' }));
			expect(onValueChange).toHaveBeenLastCalledWith(null);
		} finally {
			vi.useRealTimers();
		}
	});

	it('respects min / max and disabled days', () => {
		const { button, onValueChange } = setup({
			value: '2026-11-07',
			min: '2026-11-02',
			max: '2026-11-27',
			isDateDisabled: (d: string) => d === '2026-11-09'
		});
		fireEvent.click(button);
		expect(cell('2026-11-01')?.getAttribute('aria-disabled')).toBe('true');
		expect(cell('2026-12-01')?.getAttribute('aria-disabled')).toBe('true');
		fireEvent.click(cell('2026-11-09')!);
		expect(onValueChange).not.toHaveBeenCalled();
		expect(focusedDate()).toBe('2026-11-09');
		// A month on: clamped to max.
		key('PageDown');
		expect(focusedDate()).toBe('2026-11-27');
	});

	it('months={1} and a narrow screen show one month with the neighbouring days', () => {
		const { button } = setup({ value: '2026-11-07', months: 1 });
		fireEvent.click(button);
		expect(headings()).toEqual(['2026年11月']);
		expect(cell('2026-12-01')).not.toBeNull();
		cleanup();

		vi.stubGlobal('matchMedia', (query: string) => ({
			matches: query === '(max-width: 600px)',
			media: query,
			addEventListener: () => {},
			removeEventListener: () => {}
		}));
		const narrow = setup({ value: '2026-11-07' });
		fireEvent.click(narrow.button);
		expect(headings()).toEqual(['2026年11月']);
	});

	it('typing, IME and the host promises are DateInput’s', () => {
		const { input, onValueChange, onHostKeydown, onHostPointerdown, onblur, button } = setup();
		fireEvent.input(input, { target: { value: '2026/11/7' } });
		fireEvent.keyDown(input, { key: 'Enter', keyCode: 229, isComposing: true });
		expect(onValueChange).not.toHaveBeenCalled();
		fireEvent.keyDown(input, { key: 'Enter' });
		expect(onValueChange).toHaveBeenLastCalledWith('2026-11-07');
		expect(input.value).toBe('2026-11-07');
		fireEvent.keyDown(input, { key: 'ArrowDown', altKey: true });
		flushSync();
		expect(dialog()).not.toBeNull();
		onHostKeydown.mockClear();
		key('ArrowLeft');
		expect(onHostKeydown).not.toHaveBeenCalled();
		// Esc while composing in the dialog does not close it.
		key('Escape', { keyCode: 229, isComposing: true });
		expect(dialog()).not.toBeNull();
		fireEvent.pointerDown(cell('2026-11-06')!);
		expect(onHostPointerdown).not.toHaveBeenCalled();
		const outside = screen.getByRole('button', { name: 'Outside' });
		fireEvent.pointerDown(outside);
		outside.focus();
		flushSync();
		expect(dialog()).toBeNull();
		expect(onblur).toHaveBeenCalledTimes(1);
		expect(button.getAttribute('aria-expanded')).toBe('false');
	});
});

describe('DatePicker while open (PR #912 review)', () => {
	it('crossing the one-month width keeps focus on the tracked day', () => {
		let narrow = false;
		const listeners = new Set<() => void>();
		vi.stubGlobal('matchMedia', (query: string) => ({
			get matches() {
				return query === '(max-width: 600px)' && narrow;
			},
			media: query,
			addEventListener: (_: string, fn: () => void) => listeners.add(fn),
			removeEventListener: (_: string, fn: () => void) => listeners.delete(fn)
		}));
		const { button } = setup({ value: '2026-11-07' });
		fireEvent.click(button);
		key('PageDown');
		expect(focusedDate()).toBe('2026-12-07');
		expect(headings()).toEqual(['2026年11月', '2026年12月']);
		narrow = true;
		listeners.forEach((fn) => fn());
		flushSync();
		expect(headings()).toEqual(['2026年12月']);
		expect(focusedDate()).toBe('2026-12-07');
		key('ArrowRight');
		expect(focusedDate()).toBe('2026-12-08');
		narrow = false;
		listeners.forEach((fn) => fn());
		flushSync();
		expect(screen.getAllByRole('grid')).toHaveLength(2);
		expect(focusedDate()).toBe('2026-12-08');
	});

	it('made disabled or read-only while open: closes, and nothing is picked', async () => {
		const { button, rerender, onValueChange } = setup({ value: '2026-11-07' });
		fireEvent.click(button);
		expect(dialog()).not.toBeNull();
		await rerender({ readonly: true });
		expect(dialog()).toBeNull();
		expect(onValueChange).not.toHaveBeenCalled();
	});
});
