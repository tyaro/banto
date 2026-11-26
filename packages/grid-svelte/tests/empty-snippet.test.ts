// @vitest-environment jsdom
/** `empty` (#712): replaces the plain `emptyState` text when there are no rows. */
import { cleanup, render, screen } from '@testing-library/svelte';
import { afterEach, beforeAll, expect, it } from 'vitest';
import EmptyHarness from './EmptyHarness.svelte';

beforeAll(() => {
	globalThis.ResizeObserver = class {
		observe() {}
		unobserve() {}
		disconnect() {}
	};
});

afterEach(cleanup);

it('renders the empty snippet instead of the emptyState text', () => {
	render(EmptyHarness);
	expect(screen.getByRole('button', { name: 'Custom empty' })).toBeTruthy();
	expect(screen.queryByText('Plain text')).toBeNull();
});
