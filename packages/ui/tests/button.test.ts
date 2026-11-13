// @vitest-environment jsdom
/**
 * @banto/ui Button (Issue #556): the `@banto/theme` classes it renders, the
 * `type` default, `loading` (aria-busy, not pressable, the label kept in the
 * DOM next to the spinner so the width does not change), the icon and the
 * pass-through attributes. The look itself is the theme's CSS and the visual
 * suite's.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { createRawSnippet } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Button } from '../src/index';
import CustomIcon from './fixtures/CustomIcon.svelte';

afterEach(cleanup);

const label = (value: string) =>
	createRawSnippet(() => ({ render: () => `<span>${value}</span>` }));

describe('Button', () => {
	it('is a secondary, medium, non-submitting button by default and fires onclick', async () => {
		const onclick = vi.fn();
		render(Button, { children: label('Save'), onclick });
		const button = screen.getByRole('button', { name: 'Save' });
		expect(button.getAttribute('type')).toBe('button');
		expect(button.classList.contains('banto-btn')).toBe(true);
		expect(button.classList.contains('banto-btn--secondary')).toBe(true);
		expect(button.classList.contains('banto-btn--sm')).toBe(false);
		expect(button.hasAttribute('aria-busy')).toBe(false);
		await fireEvent.click(button);
		expect(onclick).toHaveBeenCalledTimes(1);
	});

	it.each(['primary', 'secondary', 'ghost', 'danger'] as const)(
		'puts the %s variant on the theme class',
		(variant) => {
			render(Button, { variant, children: label('x') });
			expect(screen.getByRole('button').classList.contains(`banto-btn--${variant}`)).toBe(true);
		}
	);

	it('uses the compact class for size="sm" and the given type', () => {
		render(Button, { size: 'sm', type: 'submit', children: label('x') });
		const button = screen.getByRole('button');
		expect(button.classList.contains('banto-btn--sm')).toBe(true);
		expect(button.getAttribute('type')).toBe('submit');
	});

	it('is disabled when asked', () => {
		render(Button, { disabled: true, children: label('x') });
		const button = screen.getByRole('button') as HTMLButtonElement;
		expect(button.disabled).toBe(true);
		// (A real browser sends no click to a disabled button; jsdom + delegated handlers do not model that.)
	});

	it('while loading: aria-busy, disabled, a spinner, and the label stays in the DOM', () => {
		render(Button, { loading: true, children: label('Save') });
		const button = screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement;
		expect(button.getAttribute('aria-busy')).toBe('true');
		expect(button.disabled).toBe(true);
		expect(button.classList.contains('banto-btn--loading')).toBe(true);
		const spinner = button.querySelector('.banto-btn__spinner');
		expect(spinner?.getAttribute('aria-hidden')).toBe('true');
		// The label sits in the same grid cell as the spinner (fixed width).
		const content = button.querySelector('.banto-btn__content');
		expect(content?.textContent).toContain('Save');
		// (A real browser sends no click to a disabled button; jsdom + delegated handlers do not model that.)
	});

	it('draws no spinner when not loading', () => {
		render(Button, { children: label('Save') });
		expect(document.querySelector('.banto-btn__spinner')).toBeNull();
		expect(document.querySelector('.banto-btn__content')).toBeNull();
	});

	it('draws a decorative icon sized by size, in both states', () => {
		const first = render(Button, { icon: CustomIcon, children: label('x') });
		expect(screen.getByTestId('custom-icon').getAttribute('data-size')).toBe('16');
		first.unmount();
		const second = render(Button, {
			icon: CustomIcon,
			size: 'sm',
			loading: true,
			children: label('x')
		});
		expect(screen.getByTestId('custom-icon').getAttribute('data-size')).toBe('14');
		second.unmount();
	});

	it('passes other attributes and a class through to the button', () => {
		render(Button, {
			class: 'extra',
			title: 'Tip',
			'data-testid': 'b',
			children: label('x')
		});
		const button = screen.getByTestId('b');
		expect(button.getAttribute('title')).toBe('Tip');
		expect(button.classList.contains('extra')).toBe(true);
		expect(button.classList.contains('banto-btn')).toBe(true);
	});
});
