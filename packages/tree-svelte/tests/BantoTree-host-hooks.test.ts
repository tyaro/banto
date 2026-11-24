// @vitest-environment jsdom
/**
 * #821: the three host hooks of `BantoTree` - trailing row controls (`rowActions`),
 * host-decided expansion (`expansion` / `onExpandedChange`) and the drop veto
 * (`canDrop` / `onDropTargetChange`).
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { createRawSnippet, tick } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import BantoTree from '../src/BantoTree.svelte';
import type { TreeDropRequest, TreeLabelContext, TreeNode } from '../src/core/types';

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
		{ id: 'b', label: 'Bravo', children: [{ id: 'b1', label: 'Bravo-1' }] },
		{ id: 'c', label: 'Charlie' }
	];
}

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

const row = (name: string) => screen.getByRole('treeitem', { name });
const rowNames = () => screen.getAllByRole('treeitem').map((el) => el.getAttribute('aria-label'));
const shown = () => screen.getAllByRole('treeitem').map((el) => el.getAttribute('data-node-id'));
const keyOn = (el: Element, name: string) => {
	const event = new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true });
	el.dispatchEvent(event);
	return event;
};

describe('rowActions', () => {
	const pressed = vi.fn();
	const actions = createRawSnippet<[TreeNode, TreeLabelContext]>((node, ctx) => ({
		render: () =>
			`<span><button type="button" data-testid="act-${node().id}" data-depth-seen="${ctx().depth}" aria-label="Hide ${node().label}">h</button><button type="button" data-testid="more-${node().id}" aria-label="More ${node().label}">m</button></span>`,
		setup: (el) => {
			const listener = () => pressed(node().id);
			el.querySelector('button')?.addEventListener('click', listener);
		}
	}));

	it('draws the controls on every row and keeps the row name as node.label', () => {
		render(BantoTree, { nodes: forest(), rowActions: actions, expanded: ['a'] });
		expect(screen.getByTestId('act-a1').getAttribute('data-depth-seen')).toBe('1');
		expect(rowNames()).toEqual(['Alpha', 'Alpha-1', 'Alpha-2', 'Bravo', 'Charlie']);
	});

	it('a click on a control does not select the row, start a rename or a drag', async () => {
		const onSelectionChange = vi.fn();
		pressed.mockClear();
		render(BantoTree, {
			nodes: forest(),
			rowActions: actions,
			editable: true,
			draggable: true,
			onSelectionChange
		});
		const button = screen.getByTestId('act-c');
		await fireEvent.pointerDown(button, { button: 0 });
		await fireEvent.click(button);
		await fireEvent.dblClick(button);
		expect(pressed).toHaveBeenCalledWith('c');
		expect(onSelectionChange).not.toHaveBeenCalled();
		expect(screen.queryByRole('textbox')).toBeNull();
		expect(row('Charlie').getAttribute('aria-selected')).toBe('false');
	});

	it('only the row holding the tab stop keeps its controls in the tab order', async () => {
		render(BantoTree, { nodes: forest(), rowActions: actions });
		// The first row is the tab stop of a fresh tree.
		expect(row('Alpha').tabIndex).toBe(0);
		expect(screen.getByTestId('act-a').tabIndex).toBe(0);
		expect(screen.getByTestId('more-a').tabIndex).toBe(0);
		expect(screen.getByTestId('act-b').tabIndex).toBe(-1);
		expect(screen.getByTestId('act-c').tabIndex).toBe(-1);

		row('Alpha').focus();
		keyOn(screen.getByRole('tree'), 'ArrowDown');
		await tick();
		expect(row('Bravo').tabIndex).toBe(0);
		expect(screen.getByTestId('act-a').tabIndex).toBe(-1);
		expect(screen.getByTestId('act-b').tabIndex).toBe(0);
	});

	it("keeps a host's own roving tabindex (adds no tab stop, gives back what it took)", async () => {
		// A toolbar with its own roving tab stop: only the active button is tabindex=0.
		const toolbar = createRawSnippet<[TreeNode, TreeLabelContext]>((node) => ({
			render: () =>
				`<span role="toolbar" aria-label="Tools ${node().label}"><button type="button" data-testid="t1-${node().id}" tabindex="0">1</button><button type="button" data-testid="t2-${node().id}" tabindex="-1">2</button></span>`
		}));
		const tabStops = () =>
			[...document.querySelectorAll<HTMLElement>('[data-testid^="t"]')]
				.filter((b) => b.tabIndex === 0)
				.map((b) => b.dataset.testid);
		render(BantoTree, { nodes: forest(), rowActions: toolbar });
		expect(tabStops()).toEqual(['t1-a']);

		row('Alpha').focus();
		keyOn(screen.getByRole('tree'), 'ArrowDown');
		await tick();
		expect(tabStops()).toEqual(['t1-b']);
		expect(screen.getByTestId('t2-a').getAttribute('tabindex')).toBe('-1');

		// The host moves its roving stop on an inactive row: remembered, kept out of the order.
		const t1a = screen.getByTestId('t1-a');
		const t2a = screen.getByTestId('t2-a');
		t1a.setAttribute('tabindex', '-1');
		t2a.setAttribute('tabindex', '0');
		await new Promise((r) => setTimeout(r, 0));
		expect(tabStops()).toEqual(['t1-b']);

		// Back to Alpha: the host's latest choice comes back as it wrote it.
		keyOn(screen.getByRole('tree'), 'ArrowUp');
		await tick();
		expect(tabStops()).toEqual(['t2-a']);
		expect(t1a.getAttribute('tabindex')).toBe('-1');
	});

	it("takes the host's first rewrite on a row that starts inactive as the host's", async () => {
		const toolbar = createRawSnippet<[TreeNode, TreeLabelContext]>((node) => ({
			render: () =>
				`<span><button type="button" data-testid="u1-${node().id}" tabindex="0">1</button></span>`
		}));
		render(BantoTree, { nodes: forest(), rowActions: toolbar });
		await new Promise((r) => setTimeout(r, 0));
		const u1b = screen.getByTestId('u1-b');
		expect(u1b.getAttribute('tabindex')).toBe('-1');

		// The host's first rewrite must not be mistaken for the tree's own initial hold-out.
		u1b.setAttribute('tabindex', '0');
		await new Promise((r) => setTimeout(r, 0));
		expect(u1b.tabIndex).toBe(-1); // still out of the order on an inactive row

		row('Alpha').focus();
		keyOn(screen.getByRole('tree'), 'ArrowDown');
		await tick();
		expect(u1b.getAttribute('tabindex')).toBe('0'); // the host's latest value comes back
	});

	it('focusing a control moves the tab stop to its row', async () => {
		render(BantoTree, { nodes: forest(), rowActions: actions });
		screen.getByTestId('act-c').focus();
		await tick();
		expect(row('Charlie').tabIndex).toBe(0);
		expect(row('Alpha').tabIndex).toBe(-1);
		expect(screen.getByTestId('more-c').tabIndex).toBe(0);
	});

	it('leaves the keys inside the controls alone; Escape goes back to the row', async () => {
		const onSelectionChange = vi.fn();
		const onActivate = vi.fn();
		render(BantoTree, { nodes: forest(), rowActions: actions, onSelectionChange, onActivate });
		const button = screen.getByTestId('act-c');
		button.focus();
		await tick();
		for (const name of ['Enter', ' ', 'ArrowDown', 'ArrowUp', 'Home', 'F2']) {
			expect(keyOn(button, name).defaultPrevented).toBe(false);
		}
		await tick();
		expect(onSelectionChange).not.toHaveBeenCalled();
		expect(onActivate).not.toHaveBeenCalled();
		expect(document.activeElement).toBe(button);

		expect(keyOn(button, 'Escape').defaultPrevented).toBe(true);
		expect(document.activeElement).toBe(row('Charlie'));
	});

	it('goes into the tree column of a tree-grid', () => {
		render(BantoTree, {
			nodes: forest(),
			rowActions: actions,
			columns: [{ id: 'x', header: 'X', accessor: () => 'v' }]
		});
		expect(screen.getByTestId('act-a').closest('.primary')).not.toBeNull();
	});
});

describe('expansion (host-decided)', () => {
	it('shows exactly the listed ids and only reports a toggle', async () => {
		const onExpandedChange = vi.fn();
		const view = render(BantoTree, { nodes: forest(), expansion: ['a'], onExpandedChange });
		expect(shown()).toEqual(['a', 'a1', 'a2', 'b', 'c']);

		await fireEvent.click(screen.getByRole('button', { name: /Bravo/ }));
		expect(onExpandedChange).toHaveBeenLastCalledWith(['a', 'b']);
		expect(shown()).toEqual(['a', 'a1', 'a2', 'b', 'c']); // the host has not agreed yet

		await view.rerender({ expansion: ['a', 'b'] });
		expect(shown()).toEqual(['a', 'a1', 'a2', 'b', 'b1', 'c']);
	});

	it('reports the arrow keys too (close / open)', async () => {
		const onExpandedChange = vi.fn();
		render(BantoTree, { nodes: forest(), expansion: ['a'], onExpandedChange });
		row('Alpha').focus();
		keyOn(screen.getByRole('tree'), 'ArrowLeft');
		expect(onExpandedChange).toHaveBeenLastCalledWith([]);
		expect(row('Alpha').getAttribute('aria-expanded')).toBe('true');
	});

	it("comes back to the tree's own expansion when the host stops deciding", async () => {
		const view = render(BantoTree, { nodes: forest(), expanded: ['b'] });
		expect(shown()).toEqual(['a', 'b', 'b1', 'c']);
		// "search": open the ancestors of the matches only.
		await view.rerender({ expansion: ['a'] });
		expect(shown()).toEqual(['a', 'a1', 'a2', 'b', 'c']);
		await view.rerender({ expansion: undefined });
		expect(shown()).toEqual(['a', 'b', 'b1', 'c']);
	});

	it('uncontrolled: applies the toggle and reports the new list', async () => {
		const onExpandedChange = vi.fn();
		render(BantoTree, { nodes: forest(), expanded: ['a'], onExpandedChange });
		await fireEvent.click(screen.getByRole('button', { name: /Bravo/ }));
		expect(onExpandedChange).toHaveBeenLastCalledWith(['a', 'b']);
		expect(shown()).toContain('b1');
		await fireEvent.click(screen.getByRole('button', { name: /Alpha/ }));
		expect(onExpandedChange).toHaveBeenLastCalledWith(['b']);
	});

	it('does not auto-expand roots or reveal the selection while the host decides', async () => {
		render(BantoTree, {
			nodes: forest(),
			expansion: [],
			autoExpandNewRoots: true,
			selection: ['a1']
		});
		await tick();
		expect(shown()).toEqual(['a', 'b', 'c']);
	});

	it('loads a lazy branch the host lists', async () => {
		const loadChildren = vi.fn(async () => [{ id: 'z1', label: 'Lazy-1' }]);
		render(BantoTree, {
			nodes: [{ id: 'z', label: 'Lazy', hasChildren: true }],
			expansion: ['z'],
			loadChildren
		});
		await vi.waitFor(() => expect(shown()).toEqual(['z', 'z1']));
		expect(loadChildren).toHaveBeenCalledTimes(1);
	});
});

describe('canDrop / onDropTargetChange', () => {
	/** jsdom has no layout: every row is 30px high at top 0, and the pointer "hits" `target`. */
	function stubLayout(target: () => Element | null): void {
		(document as { elementFromPoint?: unknown }).elementFromPoint = () => target();
		vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
			top: 0,
			bottom: 30,
			left: 0,
			right: 100,
			width: 100,
			height: 30,
			x: 0,
			y: 0,
			toJSON: () => ({})
		});
	}
	function pointer(type: string, x: number, y: number): MouseEvent {
		const event = new MouseEvent(type, {
			bubbles: true,
			cancelable: true,
			button: 0,
			clientX: x,
			clientY: y
		});
		Object.defineProperty(event, 'pointerId', { value: 1 });
		return event;
	}
	/** Drag `from` over `to` at vertical offset `y` (0-30) and, unless `hold`, release. */
	async function drag(from: string, to: string, y: number, hold = false): Promise<void> {
		let over: Element | null = null;
		stubLayout(() => over);
		row(from).dispatchEvent(pointer('pointerdown', 0, 0));
		over = row(to);
		window.dispatchEvent(pointer('pointermove', 50, y));
		await tick();
		if (hold) return;
		window.dispatchEvent(pointer('pointerup', 50, y));
		await tick();
	}

	it('asks the host with the dragged node, the target, the position and the new parent', async () => {
		const canDrop = vi.fn((_request: TreeDropRequest) => true);
		const onMove = vi.fn();
		render(BantoTree, { nodes: forest(), draggable: true, expanded: ['a'], canDrop, onMove });
		await drag('Charlie', 'Alpha-1', 2);
		expect(canDrop).toHaveBeenCalledTimes(1);
		const request = canDrop.mock.calls[0]?.[0];
		expect(request?.dragged.id).toBe('c');
		expect(request?.target.id).toBe('a1');
		expect(request?.position).toBe('before');
		expect(request?.parent?.id).toBe('a');
		expect(onMove).toHaveBeenCalledWith('c', 'a1', 'before');
	});

	it('a refusal marks the row, reports the reason and drops nothing', async () => {
		const onMove = vi.fn();
		const onDropTargetChange = vi.fn();
		render(BantoTree, {
			nodes: forest(),
			draggable: true,
			onMove,
			onDropTargetChange,
			canDrop: ({ target }) =>
				target.id === 'b' ? { allowed: false, reason: 'Bravo is full' } : true
		});
		await drag('Charlie', 'Bravo', 15, true);
		expect(row('Bravo').hasAttribute('data-drop-denied')).toBe(true);
		const hover = onDropTargetChange.mock.lastCall?.[0];
		expect(hover).toMatchObject({ allowed: false, reason: 'Bravo is full', position: 'inside' });
		expect(hover.parent.id).toBe('b');

		window.dispatchEvent(pointer('pointerup', 50, 15));
		await tick();
		expect(onMove).not.toHaveBeenCalled();
		expect(onDropTargetChange).toHaveBeenLastCalledWith(null);
		expect(row('Bravo').hasAttribute('data-drop-denied')).toBe(false);
	});

	it('`false` refuses without a reason; the uncontrolled forest is left as it was', async () => {
		render(BantoTree, { nodes: forest(), draggable: true, canDrop: () => false });
		await drag('Charlie', 'Alpha', 2);
		expect(shown()).toEqual(['a', 'b', 'c']);
	});

	it('is not asked for a drop the tree itself rules out (into its own subtree)', async () => {
		const canDrop = vi.fn(() => true);
		const onDropTargetChange = vi.fn();
		render(BantoTree, {
			nodes: forest(),
			draggable: true,
			expanded: ['a'],
			canDrop,
			onDropTargetChange
		});
		await drag('Alpha', 'Alpha-1', 15);
		expect(canDrop).not.toHaveBeenCalled();
		expect(onDropTargetChange).not.toHaveBeenCalled();
	});

	it('asks once per target / position, not on every pointer move', async () => {
		const canDrop = vi.fn(() => true);
		render(BantoTree, { nodes: forest(), draggable: true, canDrop });
		await drag('Charlie', 'Alpha', 2, true);
		window.dispatchEvent(pointer('pointermove', 60, 3));
		window.dispatchEvent(pointer('pointermove', 70, 4));
		expect(canDrop).toHaveBeenCalledTimes(1);
		window.dispatchEvent(pointer('pointermove', 70, 28)); // now "after"
		expect(canDrop).toHaveBeenCalledTimes(2);
		window.dispatchEvent(pointer('pointerup', 70, 28));
	});

	it('without canDrop every shape-legal drop is allowed (as before) and still reported', async () => {
		const onDropTargetChange = vi.fn();
		render(BantoTree, { nodes: forest(), draggable: true, onDropTargetChange });
		await drag('Charlie', 'Alpha', 2);
		expect(onDropTargetChange.mock.calls[0]?.[0]).toMatchObject({ allowed: true });
		expect(shown()).toEqual(['c', 'a', 'b']);
	});
});
