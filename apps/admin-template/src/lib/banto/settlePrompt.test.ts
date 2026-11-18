/**
 * The settle dialog's state (settlePrompt.svelte.ts, Issue #432 PR-10):
 * one question at a time, and every way out that is not a choice is 'cancel'.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { closeOpenMenus, createSettlePrompt } from './settlePrompt.svelte';

describe('createSettlePrompt', () => {
	it('ask opens the question and the answer closes it', async () => {
		const prompt = createSettlePrompt();
		expect(prompt.open).toBe(false);
		const answer = prompt.ask(['memo']);
		expect(prompt.open).toBe(true);
		expect(prompt.dirtyKeys).toEqual(['memo']);
		prompt.answer('discard');
		await expect(answer).resolves.toBe('discard');
		expect(prompt.open).toBe(false);
		expect(prompt.dirtyKeys).toEqual([]);
	});

	it('a new question answers the open one cancel', async () => {
		const prompt = createSettlePrompt();
		const first = prompt.ask(['a']);
		const second = prompt.ask(['b']);
		await expect(first).resolves.toBe('cancel');
		expect(prompt.dirtyKeys).toEqual(['b']);
		prompt.answer('apply');
		await expect(second).resolves.toBe('apply');
	});

	it('a second answer is ignored', async () => {
		const prompt = createSettlePrompt();
		const answer = prompt.ask(['memo']);
		prompt.answer('apply');
		prompt.answer('cancel');
		await expect(answer).resolves.toBe('apply');
	});

	it('dispose answers an open question cancel and later questions at once', async () => {
		const prompt = createSettlePrompt();
		const open = prompt.ask(['memo']);
		prompt.dispose();
		await expect(open).resolves.toBe('cancel');
		await expect(prompt.ask(['memo'])).resolves.toBe('cancel');
		expect(prompt.open).toBe(false);
	});
});

/** A `role="menu"` popover stand-in: just what closeOpenMenus touches. */
function fakeMenu(open: boolean) {
	const menu = {
		open,
		matches: (selector: string) => selector === ':popover-open' && menu.open,
		hidePopover: vi.fn(() => {
			menu.open = false;
		})
	};
	return menu;
}

function fakeDocument(menus: ReturnType<typeof fakeMenu>[]) {
	return {
		querySelectorAll: vi.fn((selector: string) =>
			selector === '[role="menu"][popover]' ? menus : []
		)
	} as unknown as Document;
}

describe('closeOpenMenus (#663: a question is the only active layer)', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('hides the open menus and leaves closed ones alone', () => {
		const openMenu = fakeMenu(true);
		const closedMenu = fakeMenu(false);
		closeOpenMenus(fakeDocument([openMenu, closedMenu]));
		expect(openMenu.hidePopover).toHaveBeenCalledTimes(1);
		expect(openMenu.open).toBe(false);
		expect(closedMenu.hidePopover).not.toHaveBeenCalled();
	});

	it('is a no-op without a DOM', () => {
		expect(() => closeOpenMenus(undefined)).not.toThrow();
	});

	it('ask closes an open menu before the question shows', async () => {
		// A checkbox item keeps its menu open on select; the dashboard's View
		// menu hiding the dirty memo asks from there.
		const menu = fakeMenu(true);
		let openWhenHidden: boolean | null = null;
		const prompt = createSettlePrompt();
		menu.hidePopover.mockImplementation(() => {
			openWhenHidden = prompt.open;
			menu.open = false;
		});
		vi.stubGlobal('document', fakeDocument([menu]));
		const answer = prompt.ask(['memo']);
		expect(menu.hidePopover).toHaveBeenCalledTimes(1);
		expect(openWhenHidden).toBe(false);
		expect(prompt.open).toBe(true);
		prompt.answer('cancel');
		await expect(answer).resolves.toBe('cancel');
	});
});
