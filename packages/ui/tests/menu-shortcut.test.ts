// @vitest-environment jsdom
/**
 * MenuItem `shortcut` (#671): keycap text (aria-hidden), accessible name stays
 * the label, `aria-keyshortcuts` carries the WAI-ARIA form; nothing without it.
 * The menu is opened (with a minimal Popover API stand-in, see menu.test.ts)
 * so role/name queries see the items.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import MenuShortcutHarness from './fixtures/MenuShortcutHarness.svelte';
import { toAriaKeyShortcuts } from '../src/index';

beforeAll(() => {
	const proto = HTMLElement.prototype as unknown as {
		showPopover(): void;
		hidePopover(): void;
	};
	proto.showPopover = function (this: HTMLElement) {
		this.style.display = 'block';
		queueMicrotask(() => {
			const event = new Event('toggle');
			Object.defineProperty(event, 'newState', { value: 'open' });
			this.dispatchEvent(event);
		});
	};
	proto.hidePopover = function (this: HTMLElement) {
		this.style.removeProperty('display');
	};
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

async function open(platform?: 'mac' | 'other') {
	render(MenuShortcutHarness, { platform });
	await fireEvent.click(screen.getByRole('button', { name: 'Open' }));
	await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe('MenuItem shortcut', () => {
	it('shows mac symbols, keeps the accessible name, sets aria-keyshortcuts', async () => {
		await open('mac');
		const item = screen.getByRole('menuitem', { name: 'Undo' });
		const key = item.querySelector('.shortcut');
		expect(key?.textContent).toBe('⇧⌘Z');
		expect(key?.getAttribute('aria-hidden')).toBe('true');
		expect(item.getAttribute('aria-keyshortcuts')).toBe('Shift+Meta+Z');
	});

	it('shows Ctrl+ text on other platforms', async () => {
		await open('other');
		const item = screen.getByRole('menuitem', { name: 'Undo' });
		expect(item.querySelector('.shortcut')?.textContent).toBe('Ctrl+Shift+Z');
		expect(item.getAttribute('aria-keyshortcuts')).toBe('Control+Shift+Z');
	});

	it('renders nothing extra without a shortcut', async () => {
		await open('other');
		const item = screen.getByRole('menuitem', { name: 'Redo' });
		expect(item.querySelector('.shortcut')).toBeNull();
		expect(item.hasAttribute('aria-keyshortcuts')).toBe(false);
	});
});

describe('MenuItem platform / ariaKeyShortcuts', () => {
	it('detects the platform after mount when none is given', async () => {
		vi.stubGlobal('navigator', { platform: 'MacIntel' });
		await open();
		const item = screen.getByRole('menuitem', { name: 'Undo' });
		expect(item.querySelector('.shortcut')?.textContent).toBe('⇧⌘Z');
		expect(item.getAttribute('aria-keyshortcuts')).toBe('Shift+Meta+Z');
	});

	it('an explicit platform wins over detection', async () => {
		vi.stubGlobal('navigator', { platform: 'MacIntel' });
		await open('other');
		const item = screen.getByRole('menuitem', { name: 'Undo' });
		expect(item.querySelector('.shortcut')?.textContent).toBe('Ctrl+Shift+Z');
	});

	it('omits aria-keyshortcuts for a symbol key, but ariaKeyShortcuts overrides', async () => {
		await open('other');
		const help = screen.getByRole('menuitem', { name: 'Help' });
		expect(help.querySelector('.shortcut')?.textContent).toBe('?');
		expect(help.hasAttribute('aria-keyshortcuts')).toBe(false);
		expect(screen.getByRole('menuitem', { name: 'Zoom' }).getAttribute('aria-keyshortcuts')).toBe(
			'Control+Slash'
		);
	});
});

describe('toAriaKeyShortcuts', () => {
	it('resolves Mod by platform and orders modifiers', () => {
		expect(toAriaKeyShortcuts('Mod+Z', 'mac')).toBe('Meta+Z');
		expect(toAriaKeyShortcuts('Mod+Z', 'other')).toBe('Control+Z');
		expect(toAriaKeyShortcuts('Alt+Shift+Ctrl+p', 'other')).toBe('Control+Alt+Shift+P');
	});
	it('names special keys and rejects garbage', () => {
		expect(toAriaKeyShortcuts('Ctrl+Space', 'other')).toBe('Control+Space');
		expect(toAriaKeyShortcuts('Escape', 'other')).toBe('Escape');
		expect(toAriaKeyShortcuts('Mod+Bogus', 'other')).toBeUndefined();
		expect(toAriaKeyShortcuts('Shift+Delete', 'other')).toBe('Shift+Delete');
		expect(toAriaKeyShortcuts('F1', 'other')).toBe('F1');
		expect(toAriaKeyShortcuts('Mod+1', 'mac')).toBe('Meta+1');
	});
	it('omits layout-dependent symbol keys', () => {
		expect(toAriaKeyShortcuts('?', 'other')).toBeUndefined();
		expect(toAriaKeyShortcuts('Shift+%', 'other')).toBeUndefined();
		expect(toAriaKeyShortcuts('Mod+/', 'other')).toBeUndefined();
		expect(toAriaKeyShortcuts('Mod++', 'other')).toBeUndefined();
	});
});
