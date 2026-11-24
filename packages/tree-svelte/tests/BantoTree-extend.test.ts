// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { createRawSnippet, tick } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import BantoTree from '../src/BantoTree.svelte';
import type { TreeLabelContext, TreeNode } from '../src/core/types';

function forest(): TreeNode[] {
	return [
		{ id: 'a', label: 'Alpha', children: [{ id: 'a1', label: 'Alpha-1' }] },
		{ id: 'b', label: 'Bravo' }
	];
}

afterEach(() => cleanup());

const badge = createRawSnippet<[TreeNode, TreeLabelContext]>((node, ctx) => ({
	render: () =>
		`<span data-testid="lbl-${node().id}">${node().label.toUpperCase()}<b>#${ctx().depth}${ctx().selected ? 's' : ''}</b></span>`
}));

describe('label snippet', () => {
	it('renders the snippet but keeps accessible names from node.label', () => {
		render(BantoTree, { nodes: forest(), label: badge, checkboxes: true });
		expect(screen.getByTestId('lbl-a').textContent).toBe('ALPHA#0');
		expect(screen.getByRole('button', { name: /Alpha/ })).toBeTruthy();
		expect(screen.getByRole('checkbox', { name: /Bravo/ })).toBeTruthy();
	});

	it('keeps the treeitem accessible name as node.label when the snippet adds a badge', () => {
		const withBadge = createRawSnippet<[TreeNode, TreeLabelContext]>((node) => ({
			render: () => `<span>${node().label}<i>(3)</i><svg aria-hidden="true"></svg></span>`
		}));
		render(BantoTree, { nodes: forest(), label: withBadge });
		expect(screen.getByRole('treeitem', { name: 'Bravo' })).toBeTruthy();
	});

	it('falls back to node.label without a snippet', () => {
		render(BantoTree, { nodes: forest() });
		expect(screen.getByText('Alpha')).toBeTruthy();
	});

	it('applies to the first column of a tree-grid', () => {
		render(BantoTree, {
			nodes: forest(),
			label: badge,
			columns: [{ id: 'x', header: 'X', accessor: () => 'v' }]
		});
		expect(screen.getByTestId('lbl-a')).toBeTruthy();
	});

	it('shows the rename input instead of the snippet while editing', async () => {
		render(BantoTree, { nodes: forest(), label: badge, editable: true });
		await fireEvent.dblClick(screen.getByTestId('lbl-b'));
		expect(screen.getByRole('textbox')).toBeTruthy();
		expect(screen.queryByTestId('lbl-b')).toBeNull();
	});
});

describe('onContextMenu', () => {
	it('is called with the node and mouse coordinates, default prevented', () => {
		const onContextMenu = vi.fn();
		render(BantoTree, { nodes: forest(), onContextMenu });
		const ev = new MouseEvent('contextmenu', {
			bubbles: true,
			cancelable: true,
			clientX: 12,
			clientY: 34
		});
		screen.getByText('Bravo').dispatchEvent(ev);
		expect(ev.defaultPrevented).toBe(true);
		expect(onContextMenu).toHaveBeenCalledOnce();
		expect(onContextMenu.mock.calls[0][0].id).toBe('b');
		expect(onContextMenu.mock.calls[0][1]).toEqual({ x: 12, y: 34 });
	});

	it('does not change the selection but moves focus to the row', async () => {
		const onSelectionChange = vi.fn();
		render(BantoTree, { nodes: forest(), onContextMenu: vi.fn(), onSelectionChange });
		await fireEvent.contextMenu(screen.getByText('Bravo'));
		await tick();
		expect(onSelectionChange).not.toHaveBeenCalled();
		const row = screen.getByText('Bravo').closest('[role="treeitem"]') as HTMLElement;
		expect(row.getAttribute('aria-selected')).toBe('false');
		expect(row.getAttribute('tabindex')).toBe('0');
	});

	it('does not prevent the default menu when not provided', () => {
		render(BantoTree, { nodes: forest() });
		const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
		screen.getByText('Bravo').dispatchEvent(ev);
		expect(ev.defaultPrevented).toBe(false);
	});

	it.each([
		['ContextMenu', false],
		['F10', true]
	])('key %s (shift=%s) calls it with the focused row position', (key, shiftKey) => {
		const onContextMenu = vi.fn();
		render(BantoTree, { nodes: forest(), onContextMenu });
		const row = screen.getByText('Alpha').closest('[role="treeitem"]') as HTMLElement;
		row.getBoundingClientRect = () => ({ left: 5, bottom: 40 }) as DOMRect;
		const ev = new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true });
		row.dispatchEvent(ev);
		expect(ev.defaultPrevented).toBe(true);
		expect(onContextMenu.mock.calls[0][0].id).toBe('a');
		expect(onContextMenu.mock.calls[0][1]).toEqual({ x: 5, y: 40 });
	});

	it('moves focus to the row before the callback so the host can take focus', async () => {
		const target = document.createElement('button');
		document.body.appendChild(target);
		const onContextMenu = vi.fn(() => target.focus());
		render(BantoTree, { nodes: forest(), onContextMenu });
		const row = screen.getByText('Bravo').closest('[role="treeitem"]') as HTMLElement;
		row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
		await tick();
		await tick();
		expect(document.activeElement).toBe(target);
		target.remove();
	});

	it('ignores plain F10', () => {
		const onContextMenu = vi.fn();
		render(BantoTree, { nodes: forest(), onContextMenu });
		const row = screen.getByText('Alpha').closest('[role="treeitem"]') as HTMLElement;
		const ev = new KeyboardEvent('keydown', { key: 'F10', bubbles: true, cancelable: true });
		row.dispatchEvent(ev);
		expect(onContextMenu).not.toHaveBeenCalled();
		expect(ev.defaultPrevented).toBe(false);
	});

	it('keeps the native menu inside the rename input', async () => {
		const onContextMenu = vi.fn();
		render(BantoTree, { nodes: forest(), editable: true, onContextMenu });
		await fireEvent.dblClick(screen.getByText('Bravo'));
		const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
		screen.getByRole('textbox').dispatchEvent(ev);
		expect(ev.defaultPrevented).toBe(false);
		expect(onContextMenu).not.toHaveBeenCalled();
	});

	it('ContextMenu key does nothing for an empty forest', () => {
		const onContextMenu = vi.fn();
		render(BantoTree, { nodes: [], onContextMenu });
		screen
			.getByRole('tree')
			.dispatchEvent(new KeyboardEvent('keydown', { key: 'ContextMenu', bubbles: true }));
		expect(onContextMenu).not.toHaveBeenCalled();
	});
});

describe('disabled rows', () => {
	const disabledForest = (): TreeNode[] => [
		{ id: 'd', label: 'Dis', disabled: true, children: [{ id: 'd1', label: 'Dis-1' }] }
	];

	it('notifies the mouse right-click', () => {
		const onContextMenu = vi.fn();
		render(BantoTree, { nodes: disabledForest(), onContextMenu });
		const row = screen.getByText('Dis').closest('[role="treeitem"]') as HTMLElement;
		row.dispatchEvent(
			new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 3, clientY: 4 })
		);
		expect(onContextMenu).toHaveBeenCalledTimes(1);
		expect(onContextMenu.mock.calls[0][0].id).toBe('d');
	});

	it('does not select, expand or activate on click / double-click / toggle', async () => {
		const onSelectionChange = vi.fn();
		const onActivate = vi.fn();
		render(BantoTree, { nodes: disabledForest(), onSelectionChange, onActivate });
		const row = screen.getByText('Dis').closest('[role="treeitem"]') as HTMLElement;
		await fireEvent.click(row);
		await fireEvent.dblClick(row);
		await fireEvent.click(screen.getByRole('button', { name: /Dis/ }));
		await tick();
		expect(onSelectionChange).not.toHaveBeenCalled();
		expect(onActivate).not.toHaveBeenCalled();
		expect(row.getAttribute('aria-expanded')).toBe('false');
		expect(screen.queryByText('Dis-1')).toBeNull();
	});
});

describe('autoExpandNewRoots', () => {
	it('is off by default', () => {
		render(BantoTree, { nodes: forest() });
		expect(screen.queryByText('Alpha-1')).toBeNull();
	});

	it('expands the initial roots', async () => {
		render(BantoTree, { nodes: forest(), autoExpandNewRoots: true });
		await tick();
		expect(screen.getByText('Alpha-1')).toBeTruthy();
	});

	it('expands a root added later, not one the user closed', async () => {
		const { rerender } = render(BantoTree, { nodes: forest(), autoExpandNewRoots: true });
		await tick();
		await fireEvent.click(screen.getByRole('button', { name: /Alpha/ })); // user closes Alpha
		expect(screen.queryByText('Alpha-1')).toBeNull();
		await rerender({
			nodes: [
				...forest(),
				{ id: 'c', label: 'Charlie', children: [{ id: 'c1', label: 'Charlie-1' }] }
			],
			autoExpandNewRoots: true
		});
		await tick();
		expect(screen.queryByText('Alpha-1')).toBeNull();
		expect(screen.getByText('Charlie-1')).toBeTruthy();
	});

	it('handles 0 roots then a root appearing', async () => {
		const { rerender } = render(BantoTree, { nodes: [], autoExpandNewRoots: true });
		await rerender({ nodes: forest(), autoExpandNewRoots: true });
		await tick();
		expect(screen.getByText('Alpha-1')).toBeTruthy();
	});

	it('does not auto-expand lazy children, and loads a lazy root once', async () => {
		const loadChildren = vi.fn(
			async () => [{ id: 'l1', label: 'Lazy-1', hasChildren: true }] as TreeNode[]
		);
		render(BantoTree, {
			nodes: [{ id: 'l', label: 'Lazy', hasChildren: true }],
			autoExpandNewRoots: true,
			loadChildren
		});
		await vi.waitFor(() => expect(screen.getByText('Lazy-1')).toBeTruthy());
		expect(loadChildren).toHaveBeenCalledTimes(1);
		const lazy1 = screen.getByText('Lazy-1').closest('[role="treeitem"]');
		expect(lazy1?.getAttribute('aria-expanded')).toBe('false');
	});
});

describe('rename input IME composition', () => {
	async function openRename(onRename = vi.fn()) {
		render(BantoTree, { nodes: forest(), editable: true, onRename });
		await fireEvent.dblClick(screen.getByText('Bravo'));
		const input = screen.getByRole('textbox') as HTMLInputElement;
		await fireEvent.input(input, { target: { value: 'Charlie' } });
		return { input, onRename };
	}

	it('ignores Enter and Escape while composing (isComposing)', async () => {
		const { input, onRename } = await openRename();
		await fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
		await fireEvent.keyDown(input, { key: 'Escape', isComposing: true });
		expect(onRename).not.toHaveBeenCalled();
		expect(screen.getByRole('textbox')).toBeTruthy();
	});

	it('ignores Enter while keyCode is 229', async () => {
		const { input, onRename } = await openRename();
		await fireEvent.keyDown(input, { key: 'Enter', keyCode: 229 });
		expect(onRename).not.toHaveBeenCalled();
		expect(screen.getByRole('textbox')).toBeTruthy();
	});

	it('still commits on a plain Enter and cancels on a plain Escape', async () => {
		const first = await openRename();
		await fireEvent.keyDown(first.input, { key: 'Enter' });
		expect(first.onRename).toHaveBeenCalledWith('b', 'Charlie');
		cleanup();
		const second = await openRename();
		await fireEvent.keyDown(second.input, { key: 'Escape' });
		expect(second.onRename).not.toHaveBeenCalled();
		expect(screen.queryByRole('textbox')).toBeNull();
	});
});
