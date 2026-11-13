// @vitest-environment jsdom
/**
 * @banto/ui Tooltip (Issue #556): shown after the delay on hover (not on
 * touch) and on keyboard focus, role="tooltip" + aria-describedby (or not,
 * for IconButton whose name is the same text), hidden on blur / press /
 * leaving, kept while the pointer is on the bubble (WCAG 1.4.13) and
 * dismissed with Esc without consuming it.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { IconButton } from '../src/index';
import CustomIcon from './fixtures/CustomIcon.svelte';
import TooltipHarness from './fixtures/TooltipHarness.svelte';

type PopoverElement = HTMLElement & { showPopover(): void; hidePopover(): void };

beforeAll(() => {
	const proto = HTMLElement.prototype as unknown as PopoverElement;
	proto.showPopover = function (this: HTMLElement) {
		if (this.dataset.popoverOpen === 'true') throw new Error('already open');
		this.dataset.popoverOpen = 'true';
		// jsdom hides any [popover] (as a closed one); the real top layer shows it.
		this.style.display = 'block';
	};
	proto.hidePopover = function (this: HTMLElement) {
		delete this.dataset.popoverOpen;
		this.style.removeProperty('display');
	};
});

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	cleanup();
	vi.useRealTimers();
});

const isShown = (el: HTMLElement | null): boolean =>
	!!el && !el.hidden && el.dataset.popoverOpen === 'true';

async function hover(el: Element, pointerType = 'mouse'): Promise<void> {
	await fireEvent.pointerEnter(el, { pointerType });
}

describe('Tooltip', () => {
	it('describes the trigger with a hidden role="tooltip" from the start', () => {
		render(TooltipHarness);
		const button = screen.getByRole('button', { name: 'Save' });
		const tip = document.getElementById(button.getAttribute('aria-describedby') ?? '');
		expect(tip?.getAttribute('role')).toBe('tooltip');
		expect(tip?.textContent?.trim()).toBe('Saves the draft');
		expect(tip?.hidden).toBe(true);
	});

	it('shows after the delay on hover and hides after leaving', async () => {
		render(TooltipHarness);
		const button = screen.getByRole('button', { name: 'Save' });
		await hover(button);
		const tip = screen.getByRole('tooltip', { hidden: true });
		expect(isShown(tip)).toBe(false);
		await vi.advanceTimersByTimeAsync(300);
		expect(isShown(tip)).toBe(true);
		await fireEvent.pointerLeave(button, { pointerType: 'mouse' });
		await vi.advanceTimersByTimeAsync(150);
		expect(isShown(tip)).toBe(false);
	});

	it('stays open while the pointer is on the bubble (WCAG 1.4.13)', async () => {
		render(TooltipHarness);
		const button = screen.getByRole('button', { name: 'Save' });
		await hover(button);
		await vi.advanceTimersByTimeAsync(300);
		const tip = screen.getByRole('tooltip');
		await fireEvent.pointerLeave(button, { pointerType: 'mouse' });
		await fireEvent.pointerEnter(tip, { pointerType: 'mouse' });
		await vi.advanceTimersByTimeAsync(500);
		expect(isShown(tip)).toBe(true);
		await fireEvent.pointerLeave(tip, { pointerType: 'mouse' });
		await vi.advanceTimersByTimeAsync(150);
		expect(isShown(tip)).toBe(false);
	});

	it('does not show for a touch', async () => {
		render(TooltipHarness);
		await hover(screen.getByRole('button', { name: 'Save' }), 'touch');
		await vi.advanceTimersByTimeAsync(1000);
		expect(isShown(screen.getByRole('tooltip', { hidden: true }))).toBe(false);
	});

	it('shows on keyboard focus and hides on blur', async () => {
		render(TooltipHarness);
		const button = screen.getByRole('button', { name: 'Save' });
		button.focus();
		await vi.advanceTimersByTimeAsync(300);
		const tip = screen.getByRole('tooltip', { hidden: true });
		expect(isShown(tip)).toBe(true);
		screen.getByRole('button', { name: 'Elsewhere' }).focus();
		await vi.advanceTimersByTimeAsync(0);
		expect(isShown(tip)).toBe(false);
	});

	it('Esc hides it without consuming the key, until the pointer leaves', async () => {
		render(TooltipHarness);
		const button = screen.getByRole('button', { name: 'Save' });
		await hover(button);
		await vi.advanceTimersByTimeAsync(300);
		const tip = screen.getByRole('tooltip');
		const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
		window.dispatchEvent(event);
		await vi.advanceTimersByTimeAsync(0);
		expect(event.defaultPrevented).toBe(false);
		expect(isShown(tip)).toBe(false);
		// Still hovering: it does not come back by itself.
		await hover(button);
		await vi.advanceTimersByTimeAsync(1000);
		expect(isShown(tip)).toBe(false);
		// A new hover after leaving shows it again.
		await fireEvent.pointerLeave(button, { pointerType: 'mouse' });
		await hover(button);
		await vi.advanceTimersByTimeAsync(300);
		expect(isShown(tip)).toBe(true);
	});

	it('a press of the trigger hides it', async () => {
		render(TooltipHarness);
		const button = screen.getByRole('button', { name: 'Save' });
		await hover(button);
		await vi.advanceTimersByTimeAsync(300);
		await fireEvent.pointerDown(button);
		expect(isShown(screen.getByRole('tooltip', { hidden: true }))).toBe(false);
	});

	it('describe={false}: no aria-describedby and no bubble until shown', async () => {
		render(TooltipHarness, { describe: false });
		const button = screen.getByRole('button', { name: 'Save' });
		expect(button.hasAttribute('aria-describedby')).toBe(false);
		expect(screen.queryByRole('tooltip', { hidden: true })).toBeNull();
		await hover(button);
		await vi.advanceTimersByTimeAsync(300);
		expect(isShown(screen.getByRole('tooltip'))).toBe(true);
	});
});

describe('IconButton tooltip', () => {
	it('shows the label in a tooltip instead of title, without describing the button', async () => {
		render(IconButton, { label: 'Close', icon: CustomIcon, onclick: () => {} });
		const button = screen.getByRole('button', { name: 'Close' });
		expect(button.hasAttribute('title')).toBe(false);
		expect(button.hasAttribute('aria-describedby')).toBe(false);
		await hover(button);
		await vi.advanceTimersByTimeAsync(300);
		expect(screen.getByRole('tooltip').textContent?.trim()).toBe('Close');
	});
});
