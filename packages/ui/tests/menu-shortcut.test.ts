// @vitest-environment jsdom
/**
 * MenuItem `shortcut` (#671): keycap text (aria-hidden), accessible name stays
 * the label, `aria-keyshortcuts` carries the WAI-ARIA form; nothing without it.
 * The menu is opened (with a minimal Popover API stand-in, see menu.test.ts)
 * so role/name queries see the items.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
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

afterEach(cleanup);

async function open(platform: 'mac' | 'other') {
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

describe('toAriaKeyShortcuts', () => {
	it('resolves Mod by platform and orders modifiers', () => {
		expect(toAriaKeyShortcuts('Mod+Z', 'mac')).toBe('Meta+Z');
		expect(toAriaKeyShortcuts('Mod+Z', 'other')).toBe('Control+Z');
		expect(toAriaKeyShortcuts('Alt+Shift+Ctrl+p', 'other')).toBe('Control+Alt+Shift+P');
	});
	it('names special keys and rejects garbage', () => {
		expect(toAriaKeyShortcuts('Ctrl+Space', 'other')).toBe('Control+Space');
		expect(toAriaKeyShortcuts('Escape', 'other')).toBe('Escape');
		expect(toAriaKeyShortcuts('Mod++', 'other')).toBe('Control+Plus');
		expect(toAriaKeyShortcuts('Mod+Bogus', 'other')).toBeUndefined();
	});
});
