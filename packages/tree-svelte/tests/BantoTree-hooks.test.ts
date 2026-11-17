// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { createRawSnippet, tick } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import BantoTree from '../src/BantoTree.svelte';
import type { TreeEmptyContext, TreeNode } from '../src/core/types';

function forest(): TreeNode[] {
	return [
		{
			id: 'a',
			label: 'Alpha',
			children: [
				{ id: 'a1', label: 'Alpha-1' },
				{ id: 'a2', label: 'Alpha-2' }
			]
		},
		{ id: 'e', label: 'Empty', children: [] },
		{ id: 'b', label: 'Bravo' }
	];
}

afterEach(() => cleanup());

const key = (name: string) =>
	screen
		.getByRole('tree')
		.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }));
const row = (name: string) => screen.getByRole('treeitem', { name });

describe('selectionFollowsFocus', () => {
	it('true (default): arrow keys select and report, as before', async () => {
		const onSelectionChange = vi.fn();
		render(BantoTree, { nodes: forest(), onSelectionChange });
		row('Alpha').focus();
		key('ArrowDown');
		await tick();
		expect(onSelectionChange).toHaveBeenCalledWith(['e']);
	});

	it('false: arrows / Home / End move only the focus', async () => {
		const onSelectionChange = vi.fn();
		render(BantoTree, { nodes: forest(), selectionFollowsFocus: false, onSelectionChange });
		row('Alpha').focus();
		key('ArrowDown');
		key('End');
		key('Home');
		await tick();
		expect(onSelectionChange).not.toHaveBeenCalled();
		expect(row('Alpha').getAttribute('aria-selected')).toBe('false');
	});

	it('false: Space, Enter and click select', async () => {
		const onSelectionChange = vi.fn();
		render(BantoTree, { nodes: forest(), selectionFollowsFocus: false, onSelectionChange });
		row('Alpha').focus();
		key(' ');
		expect(onSelectionChange).toHaveBeenLastCalledWith(['a']);
		key('ArrowDown');
		key('Enter');
		expect(onSelectionChange).toHaveBeenLastCalledWith(['e']);
		await fireEvent.click(row('Bravo'));
		expect(onSelectionChange).toHaveBeenLastCalledWith(['b']);
		expect(onSelectionChange).toHaveBeenCalledTimes(3);
	});

	it('false: Enter on a leaf selects and still activates', async () => {
		const onSelectionChange = vi.fn();
		const onActivate = vi.fn();
		render(BantoTree, {
			nodes: forest(),
			selectionFollowsFocus: false,
			onSelectionChange,
			onActivate
		});
		await fireEvent.click(row('Bravo'));
		onSelectionChange.mockClear();
		key('Enter');
		expect(onSelectionChange).toHaveBeenCalledWith(['b']);
		expect(onActivate).toHaveBeenCalledTimes(1);
	});

	it('false does not change multi mode', async () => {
		const onSelectionChange = vi.fn();
		render(BantoTree, {
			nodes: forest(),
			selectionMode: 'multi',
			selectionFollowsFocus: false,
			onSelectionChange
		});
		row('Alpha').focus();
		key('ArrowDown');
		await tick();
		expect(onSelectionChange).not.toHaveBeenCalled();
	});
});

const none = createRawSnippet<[TreeNode, TreeEmptyContext]>((node, ctx) => ({
	render: () => `<span data-testid="none-${node().id}">none d${ctx().depth}</span>`
}));

describe('emptyChildren', () => {
	it('without the snippet an empty branch is a leaf (unchanged)', () => {
		render(BantoTree, { nodes: forest() });
		expect(row('Empty').hasAttribute('aria-expanded')).toBe(false);
		expect(screen.queryByTestId('none-e')).toBeNull();
	});

	it('shows a toggle and, once expanded, a disabled treeitem line', async () => {
		render(BantoTree, { nodes: forest(), emptyChildren: none });
		expect(row('Empty').getAttribute('aria-expanded')).toBe('false');
		expect(screen.queryByTestId('none-e')).toBeNull();
		await fireEvent.click(screen.getByRole('button', { name: /Empty/ }));
		expect(row('Empty').getAttribute('aria-expanded')).toBe('true');
		const line = screen.getByTestId('none-e').closest('[role="treeitem"]')!;
		expect(line.getAttribute('aria-disabled')).toBe('true');
		expect(line.getAttribute('aria-level')).toBe('2');
		expect(line.getAttribute('data-depth')).toBe('1');
		expect(line.hasAttribute('aria-selected')).toBe(false);
		expect(screen.getByTestId('none-e').textContent).toBe('none d1');
	});

	it('the label snippet sees the branch as expandable and open', () => {
		const label = createRawSnippet(
			(node: () => TreeNode, ctx: () => { expanded: boolean; hasChildren: boolean }) => ({
				render: () =>
					`<span data-testid="lbl-${node().id}">${ctx().hasChildren ? 'branch' : 'leaf'}-${ctx().expanded ? 'open' : 'closed'}</span>`
			})
		);
		render(BantoTree, { nodes: forest(), emptyChildren: none, label });
		expect(screen.getByTestId('lbl-e').textContent).toBe('branch-closed');
		cleanup();
		render(BantoTree, { nodes: forest(), emptyChildren: none, label, expanded: ['e'] });
		expect(screen.getByTestId('lbl-e').textContent).toBe('branch-open');
	});

	it('arrow keys skip the line; it cannot be selected', async () => {
		const onSelectionChange = vi.fn();
		render(BantoTree, {
			nodes: forest(),
			expanded: ['e'],
			emptyChildren: none,
			onSelectionChange
		});
		await fireEvent.click(row('Empty'));
		onSelectionChange.mockClear();
		key('ArrowDown');
		await tick();
		expect(onSelectionChange).toHaveBeenLastCalledWith(['b']);
		key('ArrowUp');
		await tick();
		expect(onSelectionChange).toHaveBeenLastCalledWith(['e']);
		await fireEvent.click(screen.getByTestId('none-e'));
		expect(onSelectionChange).toHaveBeenCalledTimes(2);
	});

	it('a lazy branch is empty only after its load returned nothing', async () => {
		let resolve!: (n: TreeNode[]) => void;
		const loadChildren = vi.fn(() => new Promise<TreeNode[]>((r) => (resolve = r)));
		render(BantoTree, {
			nodes: [{ id: 'l', label: 'Lazy', hasChildren: true }],
			loadChildren,
			emptyChildren: none
		});
		await fireEvent.click(screen.getByRole('button', { name: /Lazy/ }));
		expect(screen.queryByTestId('none-l')).toBeNull();
		resolve([]);
		await tick();
		await tick();
		expect(screen.getByTestId('none-l')).toBeTruthy();
	});
});

describe('data-depth', () => {
	it('is 0-based and matches aria-level - 1', () => {
		render(BantoTree, { nodes: forest(), expanded: ['a'] });
		for (const el of screen.getAllByRole('treeitem')) {
			expect(Number(el.getAttribute('data-depth'))).toBe(Number(el.getAttribute('aria-level')) - 1);
		}
		expect(row('Alpha-1').getAttribute('data-depth')).toBe('1');
		expect(row('Alpha').getAttribute('data-depth')).toBe('0');
	});
});
