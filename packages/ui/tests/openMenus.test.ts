/**
 * closeOpenMenus (openMenus.ts, #670): hides the `role="menu"` popovers of a
 * root, skips those inside `except`, and is a no-op without a DOM.
 */
import { describe, expect, it, vi } from 'vitest';
import { closeOpenMenus } from '../src/openMenus';

function fakeMenu(inside = false) {
	return { hidePopover: vi.fn(), inside };
}

function fakeRoot(menus: ReturnType<typeof fakeMenu>[]) {
	return {
		querySelectorAll: vi.fn((selector: string) =>
			selector === '[role="menu"][popover]' ? menus : []
		)
	} as unknown as ParentNode;
}

describe('closeOpenMenus', () => {
	it('hides every menu of the root and returns them', () => {
		const a = fakeMenu();
		const b = fakeMenu();
		expect(closeOpenMenus(fakeRoot([a, b]))).toEqual([a, b]);
		expect(a.hidePopover).toHaveBeenCalledTimes(1);
		expect(b.hidePopover).toHaveBeenCalledTimes(1);
	});

	it('leaves the menus inside `except` alone', () => {
		const outer = fakeMenu();
		const inner = fakeMenu(true);
		const except = { contains: (node: { inside: boolean }) => node.inside } as unknown as Element;
		expect(closeOpenMenus(fakeRoot([outer, inner]), except)).toEqual([outer]);
		expect(inner.hidePopover).not.toHaveBeenCalled();
	});

	it('survives a hidePopover that throws', () => {
		const broken = fakeMenu();
		broken.hidePopover.mockImplementation(() => {
			throw new Error('not open');
		});
		expect(closeOpenMenus(fakeRoot([broken]))).toEqual([]);
	});

	it('is a no-op without a DOM', () => {
		expect(closeOpenMenus(undefined)).toEqual([]);
	});
});
