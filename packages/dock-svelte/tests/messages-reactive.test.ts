// @vitest-environment jsdom
/**
 * `messages` is reactive: a parent that swaps the bundle later (a locale
 * switch) gets the new wording without remounting. `DockedTree` and
 * `DockWindow` merge `defaultDockMessages` with `messages` via `$derived`, so
 * a rerender with new props must show the new strings.
 */
import { cleanup, render, screen } from '@testing-library/svelte';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import DockHostHarness from './DockHostHarness.svelte';
import { createDockState } from '../src/state.svelte';
import type { DockLayout } from '../src/types';

beforeAll(() => {
	globalThis.ResizeObserver = class {
		observe() {}
		unobserve() {}
		disconnect() {}
	} as unknown as typeof ResizeObserver;
});

afterEach(cleanup);

describe('messages can be swapped after mount', () => {
	it('DockedTree: the titlebar close label follows', async () => {
		const layout: DockLayout = {
			version: 2,
			floating: [],
			docked: { type: 'panel', id: 'a', title: 'A' }
		};
		const { rerender } = render(DockHostHarness, { dock: createDockState(layout) });
		expect(screen.getByRole('button', { name: 'Aを閉じる' })).toBeTruthy();

		await rerender({ messages: { close: (title: string) => `Close ${title}` } });
		expect(screen.getByRole('button', { name: 'Close A' })).toBeTruthy();
		expect(screen.queryByRole('button', { name: 'Aを閉じる' })).toBeNull();
	});

	it('DockedTree: the split divider label follows', async () => {
		const layout: DockLayout = {
			version: 2,
			floating: [],
			docked: {
				type: 'split',
				id: 's',
				direction: 'row',
				sizes: [0.5, 0.5],
				children: [
					{ type: 'panel', id: 'a', title: 'A' },
					{ type: 'panel', id: 'b', title: 'B' }
				]
			}
		};
		const { rerender } = render(DockHostHarness, { dock: createDockState(layout) });
		expect(screen.getByRole('separator', { name: 'パネルのサイズ変更' })).toBeTruthy();

		await rerender({ messages: { resizeHandle: () => 'Resize panes' } });
		expect(screen.getByRole('separator', { name: 'Resize panes' })).toBeTruthy();
	});

	it('DockWindow: the titlebar close label follows', async () => {
		const layout: DockLayout = {
			version: 2,
			floating: [{ id: 'w', title: 'W', x: 0, y: 0, width: 300, height: 200, open: true }],
			docked: null
		};
		const { rerender } = render(DockHostHarness, { dock: createDockState(layout) });
		expect(screen.getByRole('button', { name: 'Wを閉じる' })).toBeTruthy();

		await rerender({ messages: { close: (title: string) => `Close ${title}` } });
		expect(screen.getByRole('button', { name: 'Close W' })).toBeTruthy();
		expect(screen.queryByRole('button', { name: 'Wを閉じる' })).toBeNull();
	});
});
