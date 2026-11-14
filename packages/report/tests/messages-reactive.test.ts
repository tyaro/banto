// @vitest-environment jsdom
/**
 * `messages` is reactive: a parent that swaps the bundle later (a locale
 * switch) gets the new wording without remounting.
 */
import { cleanup, render, screen } from '@testing-library/svelte';
import { tick } from 'svelte';
import { afterEach, describe, expect, it } from 'vitest';
import ReportView from '../src/ReportView.svelte';

afterEach(cleanup);

describe('ReportView messages can be swapped after mount', () => {
	it('the print button follows', async () => {
		const { rerender } = render(ReportView, {
			template: '# 見出し',
			data: {},
			messages: { print: () => 'Print' }
		});
		expect(screen.getByRole('button', { name: 'Print' })).toBeTruthy();
		await rerender({ messages: { print: () => '印刷する' } });
		await tick();
		expect(screen.getByRole('button', { name: '印刷する' })).toBeTruthy();
		expect(screen.queryByRole('button', { name: 'Print' })).toBeNull();
	});
});
