// @vitest-environment jsdom
/**
 * `messages` is reactive: a parent that swaps the bundle later (a locale
 * switch) gets the new wording without remounting. `BantoTree` and
 * `TreeSelect` merge `defaultTreeMessages` with `messages` via `$derived`, so
 * a rerender with new props must show the new strings.
 */
import { cleanup, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it } from 'vitest';
import BantoTree from '../src/BantoTree.svelte';
import TreeSelect from '../src/TreeSelect.svelte';
import type { TreeNode } from '../src/core/types';

afterEach(cleanup);

const nodes: TreeNode<null>[] = [{ id: 'a', label: 'Alpha', data: null }];

describe('messages can be swapped after mount', () => {
	it('BantoTree: the empty-state text follows', async () => {
		const { rerender } = render(BantoTree<null>, { nodes: [] });
		expect(screen.getByText('項目がありません')).toBeTruthy();

		await rerender({ messages: { empty: () => 'Nothing here' } });
		expect(screen.getByText('Nothing here')).toBeTruthy();
		expect(screen.queryByText('項目がありません')).toBeNull();
	});

	it('TreeSelect: the placeholder follows (the component default is overridden by messages)', async () => {
		const { rerender } = render(TreeSelect<null>, { nodes });
		expect(screen.getByText('選択してください')).toBeTruthy();

		await rerender({ messages: { placeholder: () => 'Pick one' } });
		expect(screen.getByText('Pick one')).toBeTruthy();
		expect(screen.queryByText('選択してください')).toBeNull();
	});

	it('TreeSelect: the multiple-selection count follows', async () => {
		const { rerender } = render(TreeSelect<null>, { nodes, multiple: true, values: ['a'] });
		expect(screen.getByText('1 件選択')).toBeTruthy();

		await rerender({ messages: { selectedCount: (n: number) => `${n} selected` } });
		expect(screen.getByText('1 selected')).toBeTruthy();
	});
});
