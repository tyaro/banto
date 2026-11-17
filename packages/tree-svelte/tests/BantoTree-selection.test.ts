// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { tick } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import BantoTree from '../src/BantoTree.svelte';
import type { TreeNode } from '../src/core/types';

function forest(): TreeNode[] {
	return [
		{ id: 'a', label: 'Alpha', children: [{ id: 'a1', label: 'Alpha-1' }] },
		{ id: 'b', label: 'Bravo' }
	];
}

afterEach(() => cleanup());

const selectedIds = () =>
	screen
		.getAllByRole('treeitem')
		.filter((el) => el.getAttribute('aria-selected') === 'true')
		.map((el) => el.textContent?.replace(/[^A-Za-z-]/g, ''));

describe('selection (host-controlled)', () => {
	it('highlights `selection` and moves it when the host changes it', async () => {
		const view = render(BantoTree, { nodes: forest(), selection: ['b'] });
		expect(selectedIds()).toEqual(['Bravo']);
		await view.rerender({ nodes: forest(), selection: ['a'] });
		await tick();
		expect(selectedIds()).toEqual(['Alpha']);
	});

	it('a click only reports; the highlight snaps back when the host keeps `selection`', async () => {
		const onSelectionChange = vi.fn();
		render(BantoTree, { nodes: forest(), selection: ['b'], onSelectionChange });
		await fireEvent.click(screen.getByRole('treeitem', { name: 'Alpha' }));
		expect(onSelectionChange).toHaveBeenCalledWith(['a']);
		await tick();
		await tick();
		expect(selectedIds()).toEqual(['Bravo']);
		// the roving focus stop is back on the selected row too
		expect(screen.getByRole('treeitem', { name: 'Bravo' }).getAttribute('tabindex')).toBe('0');
		expect(screen.getByRole('treeitem', { name: 'Alpha' }).getAttribute('tabindex')).toBe('-1');
	});

	it('a click is accepted when the host moves `selection` in response', async () => {
		const onSelectionChange = vi.fn((ids: string[]) => {
			void host.rerender({ nodes: forest(), selection: ids, onSelectionChange });
		});
		const host = render(BantoTree, { nodes: forest(), selection: ['b'], onSelectionChange });
		await fireEvent.click(screen.getByRole('treeitem', { name: 'Alpha' }));
		await tick();
		await tick();
		expect(selectedIds()).toEqual(['Alpha']);
	});

	it('uncontrolled trees keep the clicked selection', async () => {
		render(BantoTree, { nodes: forest(), selected: ['b'] });
		await fireEvent.click(screen.getByRole('treeitem', { name: 'Alpha' }));
		await tick();
		expect(selectedIds()).toEqual(['Alpha']);
	});
});

describe('selection inside a closed branch', () => {
	const tabStops = () =>
		screen.getAllByRole('treeitem').filter((el) => el.getAttribute('tabindex') === '0');

	it('opens the branches above a selected child and parks the tab stop on it', async () => {
		render(BantoTree, { nodes: forest(), selection: ['a1'] });
		await tick();
		await tick();
		const child = screen.getByRole('treeitem', { name: 'Alpha-1' });
		expect(child.getAttribute('aria-selected')).toBe('true');
		expect(tabStops()).toEqual([child]);
	});

	it('does the same when the host moves `selection` into a closed branch', async () => {
		const view = render(BantoTree, { nodes: forest(), selection: ['b'] });
		expect(screen.queryByRole('treeitem', { name: 'Alpha-1' })).toBeNull();
		await view.rerender({ nodes: forest(), selection: ['a1'] });
		await tick();
		await tick();
		const child = screen.getByRole('treeitem', { name: 'Alpha-1' });
		expect(tabStops()).toEqual([child]);
	});

	it('still leaves exactly one shown row on the tab stop when the id cannot be shown', async () => {
		render(BantoTree, { nodes: forest(), selection: ['missing'] });
		await tick();
		await tick();
		expect(tabStops()).toHaveLength(1);
	});
});

describe('a refused pick keeps the browser focus with the highlight', () => {
	const leaves = (): TreeNode[] => [
		{ id: 'a', label: 'Alpha' },
		{ id: 'b', label: 'Bravo' },
		{ id: 'c', label: 'Charlie' }
	];
	const item = (name: string) => screen.getByRole('treeitem', { name });
	const settle = async () => {
		await tick();
		await tick();
	};

	it('a refused click puts the focus back on the selected row, and keys act there', async () => {
		const onSelectionChange = vi.fn();
		const onActivate = vi.fn();
		render(BantoTree, { nodes: leaves(), selection: ['b'], onSelectionChange, onActivate });
		item('Alpha').focus(); // what the browser does on mousedown
		await fireEvent.click(item('Alpha'));
		await settle();
		expect(selectedIds()).toEqual(['Bravo']);
		expect(document.activeElement).toBe(item('Bravo'));
		expect(item('Bravo').getAttribute('tabindex')).toBe('0');
		await fireEvent.keyDown(document.activeElement!, { key: 'Enter' });
		expect(onActivate).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'b' }));
		await fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
		expect(onSelectionChange).toHaveBeenLastCalledWith(['c']);
	});

	it('a refused arrow key puts the focus back too', async () => {
		const onSelectionChange = vi.fn();
		const onActivate = vi.fn();
		render(BantoTree, { nodes: leaves(), selection: ['b'], onSelectionChange, onActivate });
		item('Bravo').focus();
		await fireEvent.keyDown(item('Bravo'), { key: 'ArrowDown' });
		expect(onSelectionChange).toHaveBeenLastCalledWith(['c']);
		await settle();
		expect(selectedIds()).toEqual(['Bravo']);
		expect(document.activeElement).toBe(item('Bravo'));
		await fireEvent.keyDown(document.activeElement!, { key: 'Enter' });
		expect(onActivate).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'b' }));
		await fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' });
		expect(onSelectionChange).toHaveBeenLastCalledWith(['a']);
	});

	it('leaves the focus where the host put it (a dialog opened from onSelectionChange)', async () => {
		const outside = document.createElement('button');
		document.body.append(outside);
		try {
			render(BantoTree, {
				nodes: leaves(),
				selection: ['b'],
				onSelectionChange: () => outside.focus()
			});
			item('Bravo').focus();
			await fireEvent.keyDown(item('Bravo'), { key: 'ArrowDown' });
			await settle();
			await settle();
			expect(document.activeElement).toBe(outside);

			item('Alpha').focus();
			await fireEvent.click(item('Alpha'));
			await settle();
			await settle();
			expect(document.activeElement).toBe(outside);
			expect(selectedIds()).toEqual(['Bravo']);
		} finally {
			outside.remove();
		}
	});
});

describe('the keys start from the shown tab stop', () => {
	const twoBranches = (): TreeNode[] => [
		{ id: 'a', label: 'Alpha', children: [{ id: 'a1', label: 'Alpha-1' }] },
		{ id: 'b', label: 'Bravo', children: [{ id: 'b1', label: 'Bravo-1' }] }
	];
	const tabStops = () =>
		screen.getAllByRole('treeitem').filter((el) => el.getAttribute('tabindex') === '0');

	it('opens the second branch for its selected child and moves from there', async () => {
		const onSelectionChange = vi.fn();
		const onActivate = vi.fn();
		render(BantoTree, { nodes: twoBranches(), selection: ['b1'], onSelectionChange, onActivate });
		await tick();
		await tick();
		const child = screen.getByRole('treeitem', { name: 'Bravo-1' });
		expect(tabStops()).toEqual([child]);
		child.focus(); // Tab into the tree
		await fireEvent.keyDown(child, { key: 'Enter' });
		expect(onActivate).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'b1' }));
		await fireEvent.keyDown(child, { key: 'ArrowUp' });
		expect(onSelectionChange).toHaveBeenLastCalledWith(['b']);
	});

	it('an unknown `selection` still lets the arrow keys move from the one tab stop', async () => {
		const onSelectionChange = vi.fn();
		render(BantoTree, { nodes: twoBranches(), selection: ['missing'], onSelectionChange });
		await tick();
		await tick();
		const stops = tabStops();
		expect(stops).toHaveLength(1);
		stops[0].focus();
		await fireEvent.keyDown(stops[0], { key: 'ArrowDown' });
		expect(onSelectionChange).toHaveBeenLastCalledWith(['b']);
	});
});
